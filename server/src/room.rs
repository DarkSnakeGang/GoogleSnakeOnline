//! Room state machine: roster, roles, modes, Versus relay, Co-op sim.

use crate::colors::{color_name, first_free_claimable, is_claimable};
use crate::coop::CoopGame;
use crate::protocol::{error_envelope, Envelope};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

pub const MAX_CONNECTIONS: usize = 30;
pub const MAX_VERSUS_PLAYERS: usize = 9;
pub const MAX_COOP_PLAYERS: usize = 4;
pub const DEFAULT_DURATION_MIN: u32 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Versus,
    Coop,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Versus => "versus",
            Mode::Coop => "coop",
        }
    }

    pub fn parse(s: &str) -> Option<Mode> {
        match s.to_ascii_lowercase().as_str() {
            "versus" | "vs" => Some(Mode::Versus),
            "coop" | "co-op" | "cooperative" => Some(Mode::Coop),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Spectator,
    Player,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Spectator => "spectator",
            Role::Player => "player",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s.to_ascii_lowercase().as_str() {
            "spectator" => Some(Role::Spectator),
            "player" => Some(Role::Player),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClientState {
    pub client_id: String,
    pub display_name: Option<String>,
    pub role: Role,
    pub ready: bool,
    pub color_id: Option<u8>,
    pub join_order: u64,
    pub promote_order: Option<u64>,
    pub spectate_focus: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersusGoal {
    Score,
    Best25,
    Best50,
    Best100,
    BestAll,
}

impl VersusGoal {
    pub fn as_str(self) -> &'static str {
        match self {
            VersusGoal::Score => "score",
            VersusGoal::Best25 => "best25",
            VersusGoal::Best50 => "best50",
            VersusGoal::Best100 => "best100",
            VersusGoal::BestAll => "bestAll",
        }
    }

    pub fn parse(s: &str) -> Option<VersusGoal> {
        match s {
            "score" | "Score" => Some(VersusGoal::Score),
            "best25" | "Best25" | "best_25" => Some(VersusGoal::Best25),
            "best50" | "Best50" | "best_50" => Some(VersusGoal::Best50),
            "best100" | "Best100" | "best_100" => Some(VersusGoal::Best100),
            "bestAll" | "BestAll" | "best_all" | "all" => Some(VersusGoal::BestAll),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            VersusGoal::Score => "Score",
            VersusGoal::Best25 => "Best 25",
            VersusGoal::Best50 => "Best 50",
            VersusGoal::Best100 => "Best 100",
            VersusGoal::BestAll => "Best All",
        }
    }

    /// Apple count needed for timed goals (None = Score or Best All).
    pub fn score_threshold(self) -> Option<u32> {
        match self {
            VersusGoal::Best25 => Some(25),
            VersusGoal::Best50 => Some(50),
            VersusGoal::Best100 => Some(100),
            VersusGoal::Score | VersusGoal::BestAll => None,
        }
    }

    pub fn is_timed(self) -> bool {
        !matches!(self, VersusGoal::Score)
    }
}

#[derive(Debug, Clone)]
pub struct VersusScore {
    pub score: u32,
    pub time_ms: u64,
    pub best_score: u32,
    pub best_time_ms: Option<u64>,
    /// Fastest time to complete the room's timed versus goal (Best 25/50/100/All).
    pub best_goal_time_ms: Option<u64>,
    pub goal_completed: bool,
    pub alive: bool,
    /// Wall-clock ms when this player's run timer armed (mosaic local tick).
    pub run_started_at_ms: Option<u64>,
}

#[derive(Debug)]
pub struct Room {
    pub code: String,
    pub mode: Mode,
    pub clients: HashMap<String, ClientState>,
    pub admin_id: Option<String>,
    pub join_seq: u64,
    pub promote_seq: u64,
    pub duration_min: u32,
    pub versus_goal: VersusGoal,
    pub settings: Value,
    pub session_active: bool,
    pub attempt_deadline: Option<Instant>,
    pub attempt_expired: bool,
    pub allow_new_runs: bool,
    pub versus_scores: HashMap<String, VersusScore>,
    pub versus_boards: HashMap<String, Value>,
    /// Legacy simplified sim — unused for native co-op gameplay (kept for tests/compat).
    pub coop: Option<CoopGame>,
    /// Native co-op relay caches
    pub coop_snakes: HashMap<String, Value>,
    pub coop_collectables: Option<Value>,
    pub collectables_owner: Option<String>,
    pub coop_alive: HashMap<String, bool>,
    /// Wall-clock when any co-op player first moved (shared timer epoch).
    pub coop_timer_started_at_ms: Option<u64>,
    pub outbox: Vec<(Option<String>, Envelope)>, // None = broadcast
    pub server_seq: u64,
}

impl Room {
    pub fn new(code: String) -> Self {
        Self {
            code,
            mode: Mode::Versus,
            clients: HashMap::new(),
            admin_id: None,
            join_seq: 0,
            promote_seq: 0,
            duration_min: DEFAULT_DURATION_MIN,
            versus_goal: VersusGoal::Score,
            settings: json!({}),
            session_active: false,
            attempt_deadline: None,
            attempt_expired: false,
            allow_new_runs: true,
            versus_scores: HashMap::new(),
            versus_boards: HashMap::new(),
            coop: None,
            coop_snakes: HashMap::new(),
            coop_collectables: None,
            collectables_owner: None,
            coop_alive: HashMap::new(),
            coop_timer_started_at_ms: None,
            outbox: Vec::new(),
            server_seq: 0,
        }
    }

    fn next_seq(&mut self) -> u64 {
        self.server_seq += 1;
        self.server_seq
    }

    fn push_broadcast(&mut self, mut env: Envelope) {
        env.seq = self.next_seq();
        self.outbox.push((None, env));
    }

    fn push_broadcast_except(&mut self, except: &str, mut env: Envelope) {
        env.seq = self.next_seq();
        let targets: Vec<String> = self
            .clients
            .keys()
            .filter(|id| id.as_str() != except)
            .cloned()
            .collect();
        for tid in targets {
            self.outbox.push((Some(tid), env.clone()));
        }
    }

    fn push_to(&mut self, client_id: &str, mut env: Envelope) {
        env.seq = self.next_seq();
        self.outbox.push((Some(client_id.to_string()), env));
    }

    fn push_error(&mut self, client_id: &str, code: &str, message: &str) {
        warn!(roomId = %self.code, clientId = %client_id, code, message, event = "client_error");
        self.push_to(client_id, error_envelope(code, message));
    }

    pub fn take_outbox(&mut self) -> Vec<(Option<String>, Envelope)> {
        std::mem::take(&mut self.outbox)
    }

    fn player_cap(&self) -> usize {
        match self.mode {
            Mode::Versus => MAX_VERSUS_PLAYERS,
            Mode::Coop => MAX_COOP_PLAYERS,
        }
    }

    fn players(&self) -> Vec<&ClientState> {
        self.clients.values().filter(|c| c.role == Role::Player).collect()
    }

    fn all_players_ready(&self) -> bool {
        let players: Vec<_> = self.players();
        !players.is_empty() && players.iter().all(|p| p.ready)
    }

    fn roster_payload(&self) -> Value {
        let mut list: Vec<Value> = self
            .clients
            .values()
            .map(|c| {
                let resolved = resolve_display_name(c, &self.clients);
                json!({
                    "clientId": c.client_id,
                    "displayName": c.display_name,
                    "resolvedName": resolved,
                    "role": c.role.as_str(),
                    "ready": c.ready,
                    "colorId": c.color_id,
                    "colorName": c.color_id.map(color_name),
                    "isAdmin": self.admin_id.as_deref() == Some(c.client_id.as_str()),
                    "joinOrder": c.join_order,
                    "promoteOrder": c.promote_order,
                    "spectateFocus": c.spectate_focus,
                })
            })
            .collect();
        list.sort_by_key(|v| v["joinOrder"].as_u64().unwrap_or(0));
        json!({
            "roomCode": self.code,
            "mode": self.mode.as_str(),
            "adminId": self.admin_id,
            "durationMin": self.duration_min,
            "versusGoal": self.versus_goal.as_str(),
            "versusGoalLabel": self.versus_goal.label(),
            "sessionActive": self.session_active,
            "attemptExpired": self.attempt_expired,
            "allowNewRuns": self.allow_new_runs,
            "allPlayersReady": self.all_players_ready(),
            "collectablesOwnerId": self.collectables_owner,
            "leaderClientId": self.versus_leader_id(),
            "clients": list,
            "settings": self.settings,
        })
    }

    pub fn broadcast_roster(&mut self) {
        let payload = self.roster_payload();
        self.push_broadcast(Envelope::new("ROSTER", payload));
    }

    pub fn join(
        &mut self,
        client_id: String,
        display_name: Option<String>,
        room_code: Option<String>,
    ) -> Result<(), String> {
        if self.clients.len() >= MAX_CONNECTIONS {
            return Err("room_full".into());
        }
        if let Some(rc) = room_code {
            if !rc.is_empty() && rc != self.code {
                return Err("bad_room".into());
            }
        }
        self.join_seq += 1;
        let is_first = self.clients.is_empty();
        let client = ClientState {
            client_id: client_id.clone(),
            display_name,
            role: Role::Spectator,
            ready: false,
            color_id: None,
            join_order: self.join_seq,
            promote_order: None,
            spectate_focus: None,
        };
        self.clients.insert(client_id.clone(), client);
        if is_first {
            self.admin_id = Some(client_id.clone());
            info!(roomId = %self.code, clientId = %client_id, event = "admin_assign");
        }
        info!(roomId = %self.code, clientId = %client_id, event = "join");
        self.push_to(
            &client_id,
            Envelope::new(
                "WELCOME",
                json!({
                    "clientId": client_id,
                    "roomCode": self.code,
                    "isAdmin": self.admin_id.as_deref() == Some(client_id.as_str()),
                }),
            ),
        );
        self.broadcast_roster();
        Ok(())
    }

    pub fn leave(&mut self, client_id: &str) {
        if self.clients.remove(client_id).is_none() {
            return;
        }
        self.versus_scores.remove(client_id);
        self.versus_boards.remove(client_id);
        self.coop_snakes.remove(client_id);
        self.coop_alive.remove(client_id);
        if self.collectables_owner.as_deref() == Some(client_id) {
            self.collectables_owner = self.pick_collectables_owner();
        }
        info!(roomId = %self.code, clientId = %client_id, event = "leave");
        if self.admin_id.as_deref() == Some(client_id) {
            self.admin_id = self.next_admin();
            if let Some(ref a) = self.admin_id {
                info!(roomId = %self.code, clientId = %a, event = "admin_succession");
            }
        }
        // Last alive player disconnect must end co-op (not wait for another death msg)
        self.maybe_end_coop_all_dead();
        if !self.clients.is_empty() {
            self.broadcast_roster();
        } else if self.session_active {
            self.session_active = false;
            self.coop = None;
        }
    }

    fn next_admin(&self) -> Option<String> {
        self.clients
            .values()
            .min_by_key(|c| c.join_order)
            .map(|c| c.client_id.clone())
    }

    fn require_admin(&self, from: &str) -> Result<(), String> {
        if self.admin_id.as_deref() == Some(from) {
            Ok(())
        } else {
            Err("not_admin".into())
        }
    }

    pub fn handle(&mut self, from: &str, env: &Envelope) {
        let result = match env.msg_type.as_str() {
            "SET_ROLE" => self.cmd_set_role(from, &env.payload),
            "KICK" => self.cmd_kick(from, &env.payload),
            "SET_DURATION" => self.cmd_set_duration(from, &env.payload),
            "SET_VERSUS_GOAL" => self.cmd_set_versus_goal(from, &env.payload),
            "READY" => self.cmd_ready(from, &env.payload),
            "COLOR_CLAIM" => self.cmd_color_claim(from, &env.payload),
            "MODE_CHANGE" => self.cmd_mode_change(from, &env.payload),
            "SETTINGS_SYNC" => self.cmd_settings_sync(from, &env.payload),
            "PLAY_SYNC" => self.cmd_play_sync(from, &env.payload),
            "SESSION_START" => self.cmd_session_start(from, &env.payload),
            "SESSION_END" => self.cmd_session_end(from, &env.payload),
            "INPUT" => self.cmd_input(from, &env.payload),
            "SCORE_PULSE" => self.cmd_score_pulse(from, &env.payload),
            "ADMIN_TRANSFER" => self.cmd_admin_transfer(from, &env.payload),
            "RESYNC_REQUEST" => self.cmd_resync(from),
            "BOARD_DELTA" | "BOARD_SNAPSHOT" => self.cmd_board(from, &env.payload),
            "SPECTATE_FOCUS" => self.cmd_spectate_focus(from, &env.payload),
            "SNAKE_DELTA" => self.cmd_snake_delta(from, &env.payload),
            "COLLECTABLES_DELTA" => self.cmd_collectables_delta(from, &env.payload),
            "COOP_PLAYER_DEAD" => self.cmd_coop_player_dead(from, &env.payload),
            "COOP_GOAL" => self.cmd_coop_goal(from, &env.payload),
            "PING" => {
                self.push_to(from, Envelope::new("PONG", json!({})));
                Ok(())
            }
            "HELLO" => Ok(()), // already joined
            other => {
                warn!(roomId = %self.code, clientId = %from, msg_type = other, event = "unknown_type");
                Err(format!("unknown_type:{other}"))
            }
        };
        if let Err(e) = result {
            self.push_error(from, &e, &e);
        }
    }

    /// Admin sets player/spectator. Broadcasts roster so all clients stay in sync.
    fn cmd_set_role(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        let target = payload
            .get("clientId")
            .and_then(|v| v.as_str())
            .ok_or("missing_clientId")?
            .to_string();
        let role = payload
            .get("role")
            .and_then(|v| v.as_str())
            .and_then(Role::parse)
            .ok_or("bad_role")?;
        if !self.clients.contains_key(&target) {
            return Err("unknown_client".into());
        }
        let current = self.clients.get(&target).map(|c| c.role).unwrap();
        if current == role {
            // Idempotent — still re-broadcast so late UIs catch up
            self.broadcast_roster();
            return Ok(());
        }
        if role == Role::Player {
            let count = self.clients.values().filter(|c| c.role == Role::Player).count();
            if count >= self.player_cap() {
                return Err("player_cap".into());
            }
            self.promote_seq += 1;
            let po = self.promote_seq;
            {
                let client = self.clients.get_mut(&target).unwrap();
                client.promote_order = Some(po);
                client.role = Role::Player;
                client.ready = false;
            }
            // Co-op: assign a free color if none / colliding with another player
            if self.mode == Mode::Coop {
                self.ensure_unique_coop_color(&target);
            }
        } else if role == Role::Spectator {
            let client = self.clients.get_mut(&target).unwrap();
            client.role = Role::Spectator;
            client.ready = false;
            client.promote_order = None;
            client.spectate_focus = None;
            // Drop any focus targeting this seat — they are no longer a player.
            for c in self.clients.values_mut() {
                if c.spectate_focus.as_deref() == Some(target.as_str()) {
                    c.spectate_focus = None;
                }
            }
        }
        info!(roomId = %self.code, clientId = %target, role = role.as_str(), event = "set_role");
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_kick(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        let target = payload
            .get("clientId")
            .and_then(|v| v.as_str())
            .ok_or("missing_clientId")?
            .to_string();
        if target == from {
            return Err("cannot_kick_self".into());
        }
        if !self.clients.contains_key(&target) {
            return Err("unknown_client".into());
        }
        info!(roomId = %self.code, clientId = %target, event = "kick");
        self.push_to(
            &target,
            Envelope::new("ERROR", json!({"code":"kicked","message":"You were kicked"})),
        );
        // Mark for disconnect via special outbox target
        self.push_broadcast(Envelope::new(
            "KICK",
            json!({"clientId": target}),
        ));
        self.leave(&target);
        Ok(())
    }

    fn cmd_set_duration(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        let mins = payload
            .get("minutes")
            .and_then(|v| v.as_u64())
            .ok_or("bad_minutes")? as u32;
        if mins == 0 || mins > 24 * 60 {
            return Err("bad_minutes".into());
        }
        self.duration_min = mins;
        info!(roomId = %self.code, minutes = mins, event = "set_duration");
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_set_versus_goal(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        let raw = payload
            .get("goal")
            .and_then(|v| v.as_str())
            .ok_or("bad_versus_goal")?;
        let goal = VersusGoal::parse(raw).ok_or("bad_versus_goal")?;
        self.versus_goal = goal;
        for entry in self.versus_scores.values_mut() {
            entry.best_goal_time_ms = None;
            entry.goal_completed = false;
            // Re-evaluate from current live score against the new goal
            Self::apply_goal_progress(goal, entry, entry.score, entry.time_ms, false);
        }
        info!(roomId = %self.code, goal = goal.as_str(), event = "set_versus_goal");
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_ready(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let client = self.clients.get_mut(from).ok_or("unknown_client")?;
        if client.role != Role::Player {
            return Err("spectators_cannot_ready".into());
        }
        let ready = payload.get("ready").and_then(|v| v.as_bool()).unwrap_or(true);
        client.ready = ready;
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_color_claim(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let color_id = payload
            .get("colorId")
            .and_then(|v| v.as_u64())
            .ok_or("bad_color")? as u8;
        if !is_claimable(color_id) {
            return Err("color_not_claimable".into());
        }
        if self.mode == Mode::Coop {
            let taken = self.clients.values().any(|c| {
                c.client_id != from && c.color_id == Some(color_id) && c.role == Role::Player
            });
            if taken {
                return Err("color_taken".into());
            }
        }
        let client = self.clients.get_mut(from).ok_or("unknown_client")?;
        client.color_id = Some(color_id);
        self.broadcast_roster();
        Ok(())
    }

    fn abort_run(&mut self) {
        self.session_active = false;
        self.attempt_deadline = None;
        // Lobby can Start again; keep last-match scores until SESSION_START.
        self.allow_new_runs = true;
        if !self.versus_scores.is_empty() {
            // Preserve final results for HUD/roster until the next Start match.
            self.attempt_expired = true;
        } else {
            self.attempt_expired = false;
        }
        self.coop = None;
        self.coop_snakes.clear();
        self.coop_collectables = None;
        self.collectables_owner = None;
        self.coop_alive.clear();
        self.coop_timer_started_at_ms = None;
        // Do not clear versus_scores / versus_boards here — SESSION_START resets them.
        for c in self.clients.values_mut() {
            c.ready = false;
        }
        self.push_broadcast(Envelope::new("SESSION_END", json!({"reason":"aborted"})));
    }

    /// Collectables owner: admin if playing, else lowest promote_order player.
    fn pick_collectables_owner(&self) -> Option<String> {
        if let Some(ref admin) = self.admin_id {
            if let Some(c) = self.clients.get(admin) {
                if c.role == Role::Player {
                    return Some(admin.clone());
                }
            }
        }
        self.clients
            .values()
            .filter(|c| c.role == Role::Player)
            .min_by_key(|c| c.promote_order.unwrap_or(u64::MAX))
            .map(|c| c.client_id.clone())
    }

    /// Ensure `client_id` has a claimable color unique among co-op players.
    fn ensure_unique_coop_color(&mut self, client_id: &str) {
        let current = self.clients.get(client_id).and_then(|c| c.color_id);
        let taken: Vec<u8> = self
            .clients
            .values()
            .filter(|c| c.client_id != client_id && c.role == Role::Player)
            .filter_map(|c| c.color_id)
            .collect();
        let needs = match current {
            None => true,
            Some(id) if !is_claimable(id) => true,
            Some(id) if taken.contains(&id) => true,
            Some(_) => false,
        };
        if !needs {
            return;
        }
        if let Some(free) = first_free_claimable(&taken) {
            if let Some(c) = self.clients.get_mut(client_id) {
                c.color_id = Some(free);
            }
        }
    }

    /// After Versus→Coop or demotion: rematch any duplicate player colors.
    fn rematch_coop_colors(&mut self) {
        let mut player_ids: Vec<String> = self
            .clients
            .values()
            .filter(|c| c.role == Role::Player)
            .map(|c| c.client_id.clone())
            .collect();
        player_ids.sort();
        let mut seen: Vec<u8> = Vec::new();
        for id in player_ids {
            let cur = self.clients.get(&id).and_then(|c| c.color_id);
            let clash = match cur {
                None => true,
                Some(cid) if !is_claimable(cid) => true,
                Some(cid) if seen.contains(&cid) => true,
                Some(cid) => {
                    seen.push(cid);
                    false
                }
            };
            if clash {
                if let Some(free) = first_free_claimable(&seen) {
                    if let Some(c) = self.clients.get_mut(&id) {
                        c.color_id = Some(free);
                    }
                    seen.push(free);
                }
            }
        }
    }

    fn cmd_mode_change(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        let mode = payload
            .get("mode")
            .and_then(|v| v.as_str())
            .and_then(Mode::parse)
            .ok_or("bad_mode")?;
        self.abort_run();
        self.mode = mode;
        // Mode switch drops prior versus results (Start of a different game type)
        self.versus_scores.clear();
        self.versus_boards.clear();
        self.attempt_expired = false;
        if mode == Mode::Coop {
            // demote newest promotions until <= MAX_COOP_PLAYERS
            let mut players: Vec<_> = self
                .clients
                .values()
                .filter(|c| c.role == Role::Player)
                .map(|c| (c.client_id.clone(), c.promote_order.unwrap_or(u64::MAX)))
                .collect();
            players.sort_by_key(|(_, o)| *o);
            while players.len() > MAX_COOP_PLAYERS {
                let (id, _) = players.pop().unwrap();
                if let Some(c) = self.clients.get_mut(&id) {
                    c.role = Role::Spectator;
                    c.ready = false;
                    c.promote_order = None;
                    info!(roomId = %self.code, clientId = %id, event = "auto_demote");
                }
            }
            self.rematch_coop_colors();
        }
        info!(roomId = %self.code, mode = mode.as_str(), event = "mode_change");
        self.push_broadcast(Envelope::new(
            "MODE_CHANGE",
            json!({"mode": mode.as_str()}),
        ));
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_settings_sync(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        self.settings = payload.clone();
        info!(roomId = %self.code, clientId = %from, event = "settings_sync");
        self.push_broadcast(Envelope::new("SETTINGS_SYNC", payload.clone()));
        Ok(())
    }

    fn cmd_play_sync(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        if !self.all_players_ready() {
            return Err("not_all_ready".into());
        }
        if self.mode == Mode::Versus && !self.allow_new_runs {
            return Err("attempt_expired".into());
        }
        info!(roomId = %self.code, clientId = %from, event = "play_sync");
        self.push_broadcast(Envelope::new("PLAY_SYNC", payload.clone()));
        Ok(())
    }

    fn cmd_session_end(&mut self, from: &str, _payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        info!(roomId = %self.code, clientId = %from, event = "session_end_admin");
        self.abort_run();
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_session_start(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        if !self.all_players_ready() {
            return Err("not_all_ready".into());
        }
        self.session_active = true;
        self.attempt_expired = false;
        self.allow_new_runs = true;
        // Fresh match — drop previous attempt results
        self.versus_scores.clear();
        self.versus_boards.clear();
        self.coop = None;
        self.coop_snakes.clear();
        self.coop_collectables = None;
        self.coop_alive.clear();
        self.coop_timer_started_at_ms = None;
        if self.mode == Mode::Versus {
            self.attempt_deadline =
                Some(Instant::now() + Duration::from_secs(self.duration_min as u64 * 60));
            self.collectables_owner = None;
        } else {
            self.attempt_deadline = None;
            // Native co-op: no server grid sim — clients run Google Snake.
            let player_ids: Vec<String> = self
                .players()
                .into_iter()
                .map(|p| p.client_id.clone())
                .collect();
            for id in player_ids {
                self.coop_alive.insert(id, true);
            }
            self.collectables_owner = self.pick_collectables_owner();
        }
        info!(roomId = %self.code, mode = self.mode.as_str(), event = "session_start");
        // Prefer settings bundled with Start match (avoids race vs prior SETTINGS_SYNC)
        if let Some(settings) = payload.get("settings") {
            if settings.is_object() {
                self.settings = settings.clone();
            }
        }
        let mut start_payload = json!({
            "mode": self.mode.as_str(),
            "durationMin": self.duration_min,
            "versusGoal": self.versus_goal.as_str(),
            "versusGoalLabel": self.versus_goal.label(),
            "collectablesOwnerId": self.collectables_owner,
            "settings": self.settings,
        });
        if self.mode == Mode::Coop {
            // Spawn Y offsets depend on player count (promote order):
            // 2: [-1,+1]  3: [0,+3,-2]  4: [-1,+1,-4,+4]
            let mut slots = Vec::new();
            let mut players: Vec<&ClientState> = self.players();
            players.sort_by_key(|c| c.promote_order.unwrap_or(u64::MAX));
            let n = players.len().min(MAX_COOP_PLAYERS);
            let offsets = crate::coop::spawn_offsets(n);
            for (i, p) in players.into_iter().enumerate().take(MAX_COOP_PLAYERS) {
                let oy = offsets.get(i).copied().unwrap_or(0);
                slots.push(json!({
                    "clientId": p.client_id,
                    "slot": i,
                    "oy": oy,
                }));
            }
            start_payload["slots"] = json!(slots);
            // Timer starts when any player first moves (COOP_TIMER_START), not at Start
        }
        self.push_broadcast(Envelope::new("SESSION_START", start_payload));
        // Start match → Play for every ready player (Versus and Co-op).
        self.push_broadcast(Envelope::new("PLAY_SYNC", json!({})));
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_input(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        // Native co-op: inputs stay local. Keep handler for protocol compat.
        let _ = (from, payload);
        if self.mode != Mode::Coop {
            return Err("not_coop".into());
        }
        Ok(())
    }

    fn cmd_snake_delta(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        // Late packets after ALL_DEAD / SESSION_END — ignore quietly (no ERROR spam)
        if self.mode != Mode::Coop || !self.session_active {
            return Ok(());
        }
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player {
            return Err("not_player".into());
        }
        let mut body = payload.clone();
        if let Some(obj) = body.as_object_mut() {
            obj.insert("clientId".into(), json!(from));
        }
        let alive = payload
            .get("alive")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        self.coop_alive.insert(from.to_string(), alive);
        self.coop_snakes.insert(from.to_string(), body.clone());
        // First player move arms the shared run timer for everyone
        let wants_timer = payload
            .get("timerArm")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || payload.get("timerStartedAtMs").and_then(|v| v.as_u64()).is_some();
        if wants_timer && self.coop_timer_started_at_ms.is_none() {
            // Always stamp server wall-clock — ignore client Date.now() skew
            let ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            self.coop_timer_started_at_ms = Some(ms);
            self.push_broadcast(Envelope::new(
                "COOP_TIMER_START",
                json!({"timerStartedAtMs": ms, "clientId": from}),
            ));
        }
        // Skip sender echo — publisher already has local pose (cuts WS backlog)
        self.push_broadcast_except(from, Envelope::new("SNAKE_DELTA", body));
        if !alive {
            self.maybe_end_coop_all_dead();
        }
        Ok(())
    }

    fn cmd_collectables_delta(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        if self.mode != Mode::Coop || !self.session_active {
            return Ok(());
        }
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player {
            return Err("not_player".into());
        }
        // Any co-op player may publish after a native eat — clamp size against DoS
        if let Some(apples) = payload.get("apples").and_then(|v| v.as_array()) {
            if apples.len() > 64 {
                return Err("collectables_too_large".into());
            }
        }
        let mut body = payload.clone();
        if let Some(obj) = body.as_object_mut() {
            obj.insert("clientId".into(), json!(from));
        }
        self.coop_collectables = Some(body.clone());
        self.push_broadcast(Envelope::new("COLLECTABLES_DELTA", body));
        Ok(())
    }

    fn cmd_coop_player_dead(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        if self.mode != Mode::Coop || !self.session_active {
            return Ok(());
        }
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player {
            return Err("not_player".into());
        }
        self.coop_alive.insert(from.to_string(), false);
        if let Some(snake) = self.coop_snakes.get_mut(from) {
            if let Some(obj) = snake.as_object_mut() {
                obj.insert("alive".into(), json!(false));
                if let Some(body) = payload.get("body") {
                    obj.insert("body".into(), body.clone());
                }
            }
        }
        self.push_broadcast(Envelope::new(
            "COOP_PLAYER_DEAD",
            json!({
                "clientId": from,
                "body": payload.get("body"),
            }),
        ));
        self.maybe_end_coop_all_dead();
        Ok(())
    }

    fn cmd_coop_goal(&mut self, from: &str, _payload: &Value) -> Result<(), String> {
        if self.mode != Mode::Coop || !self.session_active {
            return Ok(());
        }
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player {
            return Err("not_player".into());
        }
        // Dead players cannot unilaterally claim ALL_APPLES win
        if self.coop_alive.get(from) == Some(&false) {
            return Err("not_alive".into());
        }
        info!(roomId = %self.code, clientId = %from, event = "coop_goal");
        self.session_active = false;
        self.coop = None;
        for c in self.clients.values_mut() {
            c.ready = false;
        }
        self.push_broadcast(Envelope::new("SESSION_END", json!({"reason":"ALL_APPLES"})));
        self.broadcast_roster();
        Ok(())
    }

    fn maybe_end_coop_all_dead(&mut self) {
        if self.mode != Mode::Coop || !self.session_active {
            return;
        }
        let players: Vec<String> = self
            .clients
            .values()
            .filter(|c| c.role == Role::Player)
            .map(|c| c.client_id.clone())
            .collect();
        if players.is_empty() {
            info!(roomId = %self.code, event = "coop_no_players");
            self.session_active = false;
            self.coop = None;
            for c in self.clients.values_mut() {
                c.ready = false;
            }
            self.push_broadcast(Envelope::new("SESSION_END", json!({"reason":"ALL_DEAD"})));
            self.broadcast_roster();
            return;
        }
        let all_dead = players.iter().all(|id| {
            self.coop_alive.get(id).copied().unwrap_or(true) == false
        });
        if !all_dead {
            return;
        }
        info!(roomId = %self.code, event = "coop_all_dead");
        self.session_active = false;
        self.coop = None;
        for c in self.clients.values_mut() {
            c.ready = false;
        }
        self.push_broadcast(Envelope::new("SESSION_END", json!({"reason":"ALL_DEAD"})));
        self.broadcast_roster();
    }

    fn cmd_score_pulse(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player || self.mode != Mode::Versus {
            return Err("not_versus_player".into());
        }
        if !self.session_active {
            return Ok(());
        }
        let score = payload
            .get("score")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(100_000) as u32;
        let time_ms = payload
            .get("timeMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(24 * 60 * 60 * 1000);
        let alive = payload.get("alive").and_then(|v| v.as_bool()).unwrap_or(true);
        // Ignore forged Best-All claims after the attempt window ends
        let mut goal_all = payload
            .get("goalAll")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if self.attempt_expired {
            goal_all = false;
        }
        let goal = self.versus_goal;
        {
            let entry = self.versus_scores.entry(from.to_string()).or_insert(VersusScore {
                score: 0,
                time_ms: 0,
                best_score: 0,
                best_time_ms: None,
                best_goal_time_ms: None,
                goal_completed: false,
                alive: true,
                run_started_at_ms: None,
            });
            entry.score = score;
            entry.time_ms = time_ms;
            entry.alive = alive;
            if let Some(started) = payload
                .get("runStartedAtMs")
                .and_then(|v| v.as_u64())
                .filter(|t| *t > 0)
            {
                // New arm resets the mosaic clock; ignore stale repeats of the same start
                if entry.run_started_at_ms != Some(started) {
                    entry.run_started_at_ms = Some(started);
                }
            }
            if !alive {
                // Keep run_started_at_ms so late viewers can still show frozen duration via timeMs
            }
            if score > entry.best_score {
                entry.best_score = score;
            }
            // Survival clock (Score mode display) — longer finished run wins ties later
            if !alive {
                match entry.best_time_ms {
                    None => entry.best_time_ms = Some(time_ms),
                    Some(best) if time_ms > best => entry.best_time_ms = Some(time_ms),
                    _ => {}
                }
            }
            Self::apply_goal_progress(goal, entry, score, time_ms, goal_all);
        }
        let sc = self.versus_scores.get(from).cloned().unwrap_or(VersusScore {
            score,
            time_ms,
            best_score: score,
            best_time_ms: None,
            best_goal_time_ms: None,
            goal_completed: false,
            alive,
            run_started_at_ms: None,
        });
        let leader_id = self.versus_leader_id();
        let mut pulse = json!({
            "clientId": from,
            "score": score,
            "timeMs": time_ms,
            "alive": alive,
            "bestScore": sc.best_score,
            "bestTimeMs": sc.best_time_ms,
            "bestGoalTimeMs": sc.best_goal_time_ms,
            "goalCompleted": sc.goal_completed,
            "versusGoal": goal.as_str(),
            "leaderClientId": leader_id,
        });
        if let Some(started) = sc.run_started_at_ms {
            if let Some(obj) = pulse.as_object_mut() {
                obj.insert("runStartedAtMs".into(), json!(started));
            }
        }
        self.push_broadcast(Envelope::new("SCORE_PULSE", pulse));
        Ok(())
    }

    /// Record timed-goal completion when score crosses the threshold or ALL clears.
    fn apply_goal_progress(
        goal: VersusGoal,
        entry: &mut VersusScore,
        score: u32,
        time_ms: u64,
        goal_all: bool,
    ) {
        if !goal.is_timed() {
            return;
        }
        let hit = match goal {
            VersusGoal::BestAll => goal_all,
            VersusGoal::Best25 | VersusGoal::Best50 | VersusGoal::Best100 => {
                goal.score_threshold()
                    .map(|n| score >= n)
                    .unwrap_or(false)
            }
            VersusGoal::Score => false,
        };
        if !hit {
            return;
        }
        entry.goal_completed = true;
        match entry.best_goal_time_ms {
            None => entry.best_goal_time_ms = Some(time_ms),
            Some(best) if time_ms < best => entry.best_goal_time_ms = Some(time_ms),
            _ => {}
        }
    }

    /// Leader for the room versus goal (Score = highest best; timed = fastest completion).
    fn versus_leader_id(&self) -> Option<String> {
        if self.mode != Mode::Versus {
            return None;
        }
        let goal = self.versus_goal;
        let mut best_id: Option<String> = None;
        if goal.is_timed() {
            let mut best_t: Option<u64> = None;
            for (id, sc) in &self.versus_scores {
                let Some(t) = sc.best_goal_time_ms else { continue };
                if !sc.goal_completed {
                    continue;
                }
                if best_t.map(|b| t < b).unwrap_or(true) {
                    best_t = Some(t);
                    best_id = Some(id.clone());
                }
            }
        } else {
            let mut best_s: Option<u32> = None;
            let mut best_t: Option<u64> = None;
            for (id, sc) in &self.versus_scores {
                let s = sc.best_score;
                if s == 0 && sc.score == 0 {
                    continue;
                }
                let t = sc.best_time_ms.unwrap_or(sc.time_ms);
                let better = match best_s {
                    None => true,
                    Some(bs) if s > bs => true,
                    Some(bs) if s == bs => best_t.map(|bt| t > bt).unwrap_or(true),
                    _ => false,
                };
                if better {
                    best_s = Some(s);
                    best_t = Some(t);
                    best_id = Some(id.clone());
                }
            }
        }
        best_id
    }

    fn score_pulse_json(&self, pid: &str, sc: &VersusScore) -> Value {
        let mut pulse = json!({
            "clientId": pid,
            "score": sc.score,
            "timeMs": sc.time_ms,
            "alive": sc.alive,
            "bestScore": sc.best_score,
            "bestTimeMs": sc.best_time_ms,
            "bestGoalTimeMs": sc.best_goal_time_ms,
            "goalCompleted": sc.goal_completed,
            "versusGoal": self.versus_goal.as_str(),
            "leaderClientId": self.versus_leader_id(),
        });
        if let Some(started) = sc.run_started_at_ms {
            if let Some(obj) = pulse.as_object_mut() {
                obj.insert("runStartedAtMs".into(), json!(started));
            }
        }
        pulse
    }

    fn cmd_admin_transfer(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        let target = payload
            .get("clientId")
            .and_then(|v| v.as_str())
            .ok_or("missing_clientId")?;
        if !self.clients.contains_key(target) {
            return Err("unknown_client".into());
        }
        self.admin_id = Some(target.to_string());
        info!(roomId = %self.code, clientId = %target, event = "admin_transfer");
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_resync(&mut self, from: &str) -> Result<(), String> {
        info!(roomId = %self.code, clientId = %from, event = "resync_request");
        if self.mode == Mode::Coop && self.session_active {
            let snakes: Vec<Value> = self.coop_snakes.values().cloned().collect();
            for snake in snakes {
                self.push_to(from, Envelope::new("SNAKE_DELTA", snake));
            }
            if let Some(ref cols) = self.coop_collectables {
                self.push_to(from, Envelope::new("COLLECTABLES_DELTA", cols.clone()));
            }
        }
        if self.mode == Mode::Versus {
            let is_spectator = self
                .clients
                .get(from)
                .map(|c| c.role == Role::Spectator)
                .unwrap_or(false);
            if is_spectator {
                let boards: Vec<(String, Value)> = self
                    .versus_boards
                    .iter()
                    .map(|(pid, board)| (pid.clone(), board.clone()))
                    .collect();
                for (pid, board) in boards {
                    self.push_to(
                        from,
                        Envelope::new(
                            "BOARD_DELTA",
                            json!({"clientId": pid, "board": board}),
                        ),
                    );
                }
            }
            let scores: Vec<(String, VersusScore)> = self
                .versus_scores
                .iter()
                .map(|(pid, sc)| (pid.clone(), sc.clone()))
                .collect();
            for (pid, sc) in scores {
                self.push_to(from, Envelope::new("SCORE_PULSE", self.score_pulse_json(&pid, &sc)));
            }
            if !self.settings.is_null() {
                self.push_to(
                    from,
                    Envelope::new("SETTINGS_SYNC", self.settings.clone()),
                );
            }
        }
        self.push_to(from, Envelope::new("ROSTER", self.roster_payload()));
        Ok(())
    }

    fn cmd_board(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player || self.mode != Mode::Versus {
            return Err("not_versus_player".into());
        }
        if !self.session_active {
            return Ok(());
        }
        if let Some(body) = payload.get("body").and_then(|v| v.as_array()) {
            if body.len() > 400 {
                return Err("board_too_large".into());
            }
        }
        self.versus_boards
            .insert(from.to_string(), payload.clone());
        // Relay to spectators only
        let spectators: Vec<String> = self
            .clients
            .values()
            .filter(|c| c.role == Role::Spectator)
            .map(|c| c.client_id.clone())
            .collect();
        let env = Envelope::new(
            "BOARD_DELTA",
            json!({"clientId": from, "board": payload}),
        );
        for sid in spectators {
            self.push_to(&sid, env.clone());
        }
        Ok(())
    }

    fn cmd_spectate_focus(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let focus = payload
            .get("clientId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // Only spectators set focus; only players can be focused.
        let from_role = self
            .clients
            .get(from)
            .map(|c| c.role)
            .ok_or("unknown_client")?;
        if from_role != Role::Spectator {
            return Err("only_spectators_focus".into());
        }
        if let Some(ref fid) = focus {
            let target = self.clients.get(fid).ok_or("unknown_focus_target")?;
            if target.role != Role::Player {
                return Err("cannot_spectate_spectator".into());
            }
        }
        let client = self.clients.get_mut(from).ok_or("unknown_client")?;
        client.spectate_focus = focus.clone();
        info!(
            roomId = %self.code,
            clientId = %from,
            focus = focus.as_deref().unwrap_or(""),
            event = "spectate_focus"
        );
        self.push_to(
            from,
            Envelope::new("SPECTATE_FOCUS", json!({"clientId": focus})),
        );
        // Push focused board immediately if we have it
        if let Some(ref fid) = focus {
            if let Some(board) = self.versus_boards.get(fid).cloned() {
                self.push_to(
                    from,
                    Envelope::new(
                        "BOARD_DELTA",
                        json!({"clientId": fid, "board": board}),
                    ),
                );
            }
        }
        Ok(())
    }

    /// Tick versus attempt timer. Native co-op has no server sim step.
    pub fn tick(&mut self) {
        if self.mode == Mode::Versus {
            if let Some(deadline) = self.attempt_deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                emit_attempt_tick(self, remaining.as_millis() as u64);
                if Instant::now() >= deadline && !self.attempt_expired {
                    self.attempt_expired = true;
                    self.allow_new_runs = false;
                    // Match is over — leave lobby so clients reopen death/settings
                    // (Focus/mosaic gate on sessionActive).
                    self.session_active = false;
                    self.attempt_deadline = None;
                    info!(roomId = %self.code, event = "attempt_expired");
                    let winner = self.versus_leader_id();
                    self.push_broadcast(Envelope::new(
                        "ATTEMPT_EXPIRED",
                        json!({
                            "winnerClientId": winner,
                            "versusGoal": self.versus_goal.as_str(),
                            "versusGoalLabel": self.versus_goal.label(),
                        }),
                    ));
                    self.broadcast_roster();
                }
            }
        }
        // Co-op: gameplay is native-client; server only relays SNAKE/COLLECTABLES.
    }
}

fn emit_attempt_tick(room: &mut Room, remaining_ms: u64) {
    // Throttle using tick counter embedded in seq: only emit when seq divisible by 10 after bump
    let seq = room.next_seq();
    if seq % 10 != 0 {
        return;
    }
    room.outbox.push((
        None,
        Envelope::new("ATTEMPT_TICK", json!({"remainingMs": remaining_ms})).with_seq(seq),
    ));
}

pub fn resolve_display_name(
    client: &ClientState,
    all: &HashMap<String, ClientState>,
) -> String {
    if let Some(ref n) = client.display_name {
        let t = n.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if client.role == Role::Spectator && client.color_id.is_none() {
        return "Spectator".into();
    }
    let base = client
        .color_id
        .map(color_name)
        .unwrap_or("Spectator")
        .to_string();
    let mut same: Vec<_> = all
        .values()
        .filter(|o| {
            o.color_id == client.color_id
                && o.display_name.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true)
        })
        .collect();
    same.sort_by_key(|c| c.join_order);
    let idx = same
        .iter()
        .position(|c| c.client_id == client.client_id)
        .unwrap_or(0);
    if idx == 0 {
        base
    } else {
        format!("{} {}", base, idx + 1)
    }
}

pub fn generate_room_code() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..4)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::parse_envelope;

    fn room() -> Room {
        Room::new("TEST".into())
    }

    #[test]
    fn spectate_focus_rejects_spectator_target() {
        let mut r = room();
        r.join("admin".into(), None, None).unwrap();
        r.join("p1".into(), None, None).unwrap();
        r.join("s1".into(), None, None).unwrap();
        r.cmd_set_role("admin", &json!({"clientId": "p1", "role": "player"}))
            .unwrap();
        // s1 is spectator focusing another spectator (admin) — reject
        assert_eq!(
            r.cmd_spectate_focus("s1", &json!({"clientId": "admin"}))
                .unwrap_err(),
            "cannot_spectate_spectator"
        );
        // player cannot set focus
        assert_eq!(
            r.cmd_spectate_focus("p1", &json!({"clientId": "p1"}))
                .unwrap_err(),
            "only_spectators_focus"
        );
        // spectator → player is ok
        r.cmd_spectate_focus("s1", &json!({"clientId": "p1"}))
            .unwrap();
        assert_eq!(
            r.clients["s1"].spectate_focus.as_deref(),
            Some("p1")
        );
        // demoting focused player clears focus pointers
        r.cmd_set_role("admin", &json!({"clientId": "p1", "role": "spectator"}))
            .unwrap();
        assert!(r.clients["s1"].spectate_focus.is_none());
    }

    #[test]
    fn join_spectator_first_admin() {
        let mut r = room();
        r.join("c1".into(), None, None).unwrap();
        assert_eq!(r.admin_id.as_deref(), Some("c1"));
        assert_eq!(r.clients["c1"].role, Role::Spectator);
    }

    #[test]
    fn reject_31st() {
        let mut r = room();
        for i in 0..30 {
            r.join(format!("c{i}"), None, None).unwrap();
        }
        assert_eq!(r.join("overflow".into(), None, None).unwrap_err(), "room_full");
    }

    #[test]
    fn set_role_caps() {
        let mut r = room();
        r.join("admin".into(), None, None).unwrap();
        for i in 0..9 {
            r.join(format!("p{i}"), None, None).unwrap();
            r.cmd_set_role(
                "admin",
                &json!({"clientId": format!("p{i}"), "role": "player"}),
            )
            .unwrap();
        }
        r.join("extra".into(), None, None).unwrap();
        assert_eq!(
            r.cmd_set_role("admin", &json!({"clientId": "extra", "role": "player"}))
                .unwrap_err(),
            "player_cap"
        );
    }

    #[test]
    fn ready_gate() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_set_role("a", &json!({"clientId": "b", "role": "player"}))
            .unwrap();
        assert!(r.cmd_session_start("a", &json!({})).unwrap_err().contains("not_all_ready"));
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("b", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        assert!(r.session_active);
    }

    #[test]
    fn admin_session_end_aborts() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_set_role("a", &json!({"clientId": "b", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("b", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        assert!(r.session_active);
        assert_eq!(
            r.cmd_session_end("b", &json!({})).unwrap_err(),
            "not_admin"
        );
        r.cmd_session_end("a", &json!({})).unwrap();
        assert!(!r.session_active);
        assert!(r.clients.values().all(|c| !c.ready));
    }

    #[test]
    fn mode_switch_demotes() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        for i in 0..5 {
            let id = format!("p{i}");
            r.join(id.clone(), None, None).unwrap();
            r.cmd_set_role("a", &json!({"clientId": id, "role": "player"}))
                .unwrap();
        }
        r.cmd_mode_change("a", &json!({"mode": "coop"})).unwrap();
        let players = r.players().len();
        assert_eq!(players, 4);
    }

    #[test]
    fn coop_color_unique() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.cmd_mode_change("a", &json!({"mode": "coop"})).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_set_role("a", &json!({"clientId": "b", "role": "player"}))
            .unwrap();
        r.cmd_color_claim("a", &json!({"colorId": 0})).unwrap();
        assert_eq!(
            r.cmd_color_claim("b", &json!({"colorId": 0})).unwrap_err(),
            "color_taken"
        );
    }

    #[test]
    fn succession_on_leave() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.leave("a");
        assert_eq!(r.admin_id.as_deref(), Some("b"));
    }

    #[test]
    fn non_admin_rejected() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        let env = parse_envelope(r#"{"v":1,"type":"MODE_CHANGE","payload":{"mode":"coop"}}"#).unwrap();
        r.handle("b", &env);
        let out = r.take_outbox();
        assert!(out.iter().any(|(_, e)| e.msg_type == "ERROR"));
    }

    #[test]
    fn play_sync_rejects_when_expired() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        r.allow_new_runs = false;
        r.attempt_expired = true;
        assert_eq!(
            r.cmd_play_sync("a", &json!({})).unwrap_err(),
            "attempt_expired"
        );
        // SESSION_START still allowed to open a new window
        r.cmd_session_start("a", &json!({})).unwrap();
        assert!(r.allow_new_runs);
    }

    #[test]
    fn versus_scores_survive_expire_and_abort_until_next_start() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_set_role("a", &json!({"clientId": "b", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("b", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        r.cmd_score_pulse(
            "a",
            &json!({"score": 9, "timeMs": 1000, "alive": false}),
        )
        .unwrap();
        r.cmd_score_pulse(
            "b",
            &json!({"score": 3, "timeMs": 500, "alive": false}),
        )
        .unwrap();
        assert_eq!(r.versus_scores.len(), 2);

        // Timer expiry keeps scores and ends the live session
        r.attempt_expired = true;
        r.allow_new_runs = false;
        r.session_active = false;
        assert_eq!(r.versus_scores["a"].best_score, 9);
        assert!(!r.session_active);

        // End match keeps scores for display; marks attempt_expired
        r.cmd_session_end("a", &json!({})).unwrap();
        assert!(!r.session_active);
        assert!(r.attempt_expired);
        assert_eq!(r.versus_scores.len(), 2);
        assert_eq!(r.versus_scores["a"].best_score, 9);

        // Next Start match clears prior results
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("b", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        assert!(r.versus_scores.is_empty());
        assert!(!r.attempt_expired);
        assert!(r.allow_new_runs);
    }

    #[test]
    fn attempt_expire_clears_session_active() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_set_duration("a", &json!({"minutes": 1})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        assert!(r.session_active);
        assert!(r.attempt_deadline.is_some());
        // Force deadline into the past
        r.attempt_deadline = Some(std::time::Instant::now() - std::time::Duration::from_secs(1));
        r.tick();
        assert!(r.attempt_expired);
        assert!(!r.allow_new_runs);
        assert!(!r.session_active);
        assert!(r.attempt_deadline.is_none());
        let out = r.take_outbox();
        assert!(out.iter().any(|(_, e)| e.msg_type == "ATTEMPT_EXPIRED"));
    }

    #[test]
    fn snake_delta_skips_sender_echo() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.cmd_mode_change("a", &json!({"mode": "coop"})).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_set_role("a", &json!({"clientId": "b", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("b", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        r.take_outbox();
        r.cmd_snake_delta(
            "a",
            &json!({"body": [{"x": 1, "y": 1}], "alive": true}),
        )
        .unwrap();
        let out = r.take_outbox();
        let deltas: Vec<_> = out
            .iter()
            .filter(|(_, e)| e.msg_type == "SNAKE_DELTA")
            .collect();
        assert!(!deltas.is_empty());
        assert!(
            deltas.iter().all(|(tid, _)| tid.as_deref() == Some("b")),
            "SNAKE_DELTA must not echo to sender"
        );
    }

    #[test]
    fn settings_sync_fanout() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.take_outbox();
        r.cmd_settings_sync("a", &json!({"trophy": 1, "speed": 2}))
            .unwrap();
        let out = r.take_outbox();
        assert!(out.iter().any(|(_, e)| e.msg_type == "SETTINGS_SYNC"));
        assert_eq!(r.settings["trophy"], 1);
    }

    #[test]
    fn resync_pushes_versus_boards_to_spectator() {
        let mut r = room();
        r.join("admin".into(), None, None).unwrap();
        r.join("player".into(), None, None).unwrap();
        r.join("spec".into(), None, None).unwrap();
        r.cmd_set_role("admin", &json!({"clientId": "player", "role": "player"}))
            .unwrap();
        r.versus_boards
            .insert("player".into(), json!({"score": 3, "body": [{"x":1,"y":1}]}));
        r.take_outbox();
        r.cmd_resync("spec").unwrap();
        let out = r.take_outbox();
        assert!(out.iter().any(|(to, e)| {
            to.as_deref() == Some("spec") && e.msg_type == "BOARD_DELTA"
        }));
        assert!(out.iter().any(|(to, e)| {
            to.as_deref() == Some("spec") && e.msg_type == "ROSTER"
        }));
    }

    #[test]
    fn coop_snapshot_on_session_start() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.cmd_mode_change("a", &json!({"mode": "coop"})).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_color_claim("a", &json!({"colorId": 35})).unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.take_outbox();
        r.cmd_session_start("a", &json!({})).unwrap();
        let out = r.take_outbox();
        let start = out
            .iter()
            .find(|(_, e)| e.msg_type == "SESSION_START")
            .expect("SESSION_START");
        assert!(out.iter().any(|(_, e)| e.msg_type == "PLAY_SYNC"));
        assert!(r.collectables_owner.as_deref() == Some("a"));
        let slots = start.1.payload.get("slots").and_then(|v| v.as_array());
        assert!(slots.is_some(), "coop SESSION_START must include slots");
        let slots = slots.unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0]["clientId"], "a");
        assert_eq!(slots[0]["oy"], 0);
    }

    #[test]
    fn coop_snake_delta_relays_and_all_dead_ends() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.cmd_mode_change("a", &json!({"mode": "coop"})).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_set_role("a", &json!({"clientId": "b", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("b", &json!({"ready": true})).unwrap();
        r.take_outbox();
        r.cmd_session_start("a", &json!({})).unwrap();
        r.take_outbox();
        r.cmd_snake_delta(
            "a",
            &json!({"body":[{"x":1,"y":1}],"alive":false,"width":17,"height":15}),
        )
        .unwrap();
        r.cmd_snake_delta(
            "b",
            &json!({"body":[{"x":2,"y":2}],"alive":false,"width":17,"height":15}),
        )
        .unwrap();
        let out = r.take_outbox();
        assert!(out.iter().any(|(_, e)| e.msg_type == "SESSION_END"));
        assert!(!r.session_active);
    }
}
