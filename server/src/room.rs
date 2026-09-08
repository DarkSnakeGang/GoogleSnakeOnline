//! Room state machine: roster, roles, modes, Race relay, Co-op sim.

use crate::colors::{color_name, first_free_claimable, is_claimable};
use crate::coop::{board_dims, CoopGame, CoopStartConfig, Dir};
use crate::protocol::{error_envelope, Envelope};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

pub const MAX_CONNECTIONS: usize = 30;
pub const MAX_RACE_PLAYERS: usize = 9;
pub const MAX_COOP_PLAYERS: usize = 4;
pub const DEFAULT_DURATION_MIN: u32 = 30;

const SERVER_SIM_AUTHORITY: &str = "server-sim-v1";
const NATIVE_RELAY_AUTHORITY: &str = "native-relay-v1";
const MAX_NATIVE_BODY_LEN: usize = 400;
const MAX_NATIVE_MODE_KEY_LEN: usize = 96;
const MAX_NATIVE_TURNS: usize = 8;
const MAX_NATIVE_POSE_BYTES: usize = 64 * 1024;
const MAX_NATIVE_VISUAL_STRING_LEN: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoopAuthority {
    ServerSim,
    NativeRelay,
}

impl CoopAuthority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ServerSim => SERVER_SIM_AUTHORITY,
            Self::NativeRelay => NATIVE_RELAY_AUTHORITY,
        }
    }

    pub fn server_auth(self) -> bool {
        self == Self::ServerSim
    }
}

#[derive(Debug, Clone)]
pub struct NativeRelayState {
    pub board_ready: bool,
    pub board_revision: u64,
    pub board_snapshot: Option<Value>,
    pub mode_key: Option<String>,
    pub initializer_id: Option<String>,
    pub last_event_seq: HashMap<String, u64>,
    pub last_pose_seq: HashMap<String, u64>,
    pub last_move_seq: HashMap<String, u64>,
    pub last_turn_seq: HashMap<String, u64>,
    pub turn_journals: HashMap<String, Vec<Value>>,
    pub poses: HashMap<String, Value>,
    pub speed_epoch: u64,
    pub effective_speed: Value,
    pub speed_sources: HashSet<String>,
    pub ending: bool,
}

impl NativeRelayState {
    fn new(initializer_id: Option<String>, effective_speed: Value) -> Self {
        Self {
            board_ready: false,
            board_revision: 0,
            board_snapshot: None,
            mode_key: None,
            initializer_id,
            last_event_seq: HashMap::new(),
            last_pose_seq: HashMap::new(),
            last_move_seq: HashMap::new(),
            last_turn_seq: HashMap::new(),
            turn_journals: HashMap::new(),
            poses: HashMap::new(),
            speed_epoch: 0,
            effective_speed,
            speed_sources: HashSet::new(),
            ending: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Race,
    Coop,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Race => "race",
            Mode::Coop => "coop",
        }
    }

    pub fn parse(s: &str) -> Option<Mode> {
        match s.to_ascii_lowercase().as_str() {
            "race" | "versus" | "vs" => Some(Mode::Race),
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
pub enum RaceGoal {
    Score,
    Best25,
    Best50,
    Best100,
    BestAll,
}

impl RaceGoal {
    pub fn as_str(self) -> &'static str {
        match self {
            RaceGoal::Score => "score",
            RaceGoal::Best25 => "best25",
            RaceGoal::Best50 => "best50",
            RaceGoal::Best100 => "best100",
            RaceGoal::BestAll => "bestAll",
        }
    }

    pub fn parse(s: &str) -> Option<RaceGoal> {
        match s {
            "score" | "Score" => Some(RaceGoal::Score),
            "best25" | "Best25" | "best_25" => Some(RaceGoal::Best25),
            "best50" | "Best50" | "best_50" => Some(RaceGoal::Best50),
            "best100" | "Best100" | "best_100" => Some(RaceGoal::Best100),
            "bestAll" | "BestAll" | "best_all" | "all" => Some(RaceGoal::BestAll),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            RaceGoal::Score => "Score",
            RaceGoal::Best25 => "Best 25",
            RaceGoal::Best50 => "Best 50",
            RaceGoal::Best100 => "Best 100",
            RaceGoal::BestAll => "Best All",
        }
    }

    /// Apple count needed for timed goals (None = Score or Best All).
    pub fn score_threshold(self) -> Option<u32> {
        match self {
            RaceGoal::Best25 => Some(25),
            RaceGoal::Best50 => Some(50),
            RaceGoal::Best100 => Some(100),
            RaceGoal::Score | RaceGoal::BestAll => None,
        }
    }

    pub fn is_timed(self) -> bool {
        !matches!(self, RaceGoal::Score)
    }
}

#[derive(Debug, Clone)]
pub struct RaceScore {
    pub score: u32,
    pub time_ms: u64,
    pub best_score: u32,
    pub best_time_ms: Option<u64>,
    /// Fastest run time at which `best_score` was reached. Breaks ties when a
    /// timed goal is never met, so the highest score with the fastest time wins.
    pub best_score_time_ms: Option<u64>,
    /// Fastest time to complete the room's timed race goal (Best 25/50/100/All).
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
    pub race_goal: RaceGoal,
    pub settings: Value,
    pub session_active: bool,
    pub attempt_deadline: Option<Instant>,
    pub attempt_expired: bool,
    pub allow_new_runs: bool,
    /// When the attempt clock hits zero, keep live runs going until they die/ALL.
    pub finish_ongoing_runs: bool,
    pub race_scores: HashMap<String, RaceScore>,
    pub race_boards: HashMap<String, Value>,
    /// Server-authoritative co-op sim (Plan 1). Race never uses this.
    pub coop: Option<CoopGame>,
    /// Accumulator for co-op step interval (main loop is 100ms).
    pub coop_accum_ms: u64,
    /// Relay caches (legacy / resync chrome; STATE is authority in Live)
    pub coop_snakes: HashMap<String, Value>,
    pub coop_collectables: Option<Value>,
    pub collectables_owner: Option<String>,
    pub coop_alive: HashMap<String, bool>,
    /// Clients that have published at least one live seated pose this session.
    pub coop_seated: HashMap<String, bool>,
    /// Wall-clock when any co-op player first moved (shared timer epoch).
    pub coop_timer_started_at_ms: Option<u64>,
    /// Frozen co-op seat order for the live session (client ids by slot index).
    pub coop_slots: Vec<String>,
    /// Server rollout gate. Read only when a new co-op generation starts.
    pub coop_native_relay_enabled: bool,
    /// Monotonic room-local co-op generation number.
    pub coop_generation: u64,
    /// Frozen authority for the active generation.
    pub coop_authority: Option<CoopAuthority>,
    /// Settings snapshot used by the active generation.
    pub coop_run_settings: Option<Value>,
    /// Native-only generation state. Never populated for server simulation.
    pub native_relay: Option<NativeRelayState>,
    pub outbox: Vec<(Option<String>, Envelope)>, // None = broadcast
    pub server_seq: u64,
}

impl Room {
    pub fn new(code: String) -> Self {
        Self::new_with_coop_native_relay(code, false)
    }

    pub fn new_with_coop_native_relay(code: String, coop_native_relay_enabled: bool) -> Self {
        Self {
            code,
            mode: Mode::Race,
            clients: HashMap::new(),
            admin_id: None,
            join_seq: 0,
            promote_seq: 0,
            duration_min: DEFAULT_DURATION_MIN,
            race_goal: RaceGoal::Score,
            settings: json!({}),
            session_active: false,
            attempt_deadline: None,
            attempt_expired: false,
            allow_new_runs: true,
            finish_ongoing_runs: true,
            race_scores: HashMap::new(),
            race_boards: HashMap::new(),
            coop: None,
            coop_accum_ms: 0,
            coop_snakes: HashMap::new(),
            coop_collectables: None,
            collectables_owner: None,
            coop_alive: HashMap::new(),
            coop_seated: HashMap::new(),
            coop_timer_started_at_ms: None,
            coop_slots: Vec::new(),
            coop_native_relay_enabled,
            coop_generation: 0,
            coop_authority: None,
            coop_run_settings: None,
            native_relay: None,
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
            Mode::Race => MAX_RACE_PLAYERS,
            Mode::Coop => MAX_COOP_PLAYERS,
        }
    }

    fn players(&self) -> Vec<&ClientState> {
        self.clients
            .values()
            .filter(|c| c.role == Role::Player)
            .collect()
    }

    /// Deterministic co-op seat order: promote_order, then join_order.
    fn ordered_coop_players(&self) -> Vec<&ClientState> {
        let mut players: Vec<&ClientState> = self.players();
        players.sort_by_key(|c| (c.promote_order.unwrap_or(u64::MAX), c.join_order));
        players
    }

    /// Slot index (0-based) for a client. During a live session uses the frozen
    /// `coop_slots` list; otherwise recomputes from current player order.
    fn coop_slot_of(&self, client_id: &str) -> Option<usize> {
        if self.mode != Mode::Coop {
            return None;
        }
        if self.session_active && !self.coop_slots.is_empty() {
            return self.coop_slots.iter().position(|id| id == client_id);
        }
        self.ordered_coop_players()
            .iter()
            .take(MAX_COOP_PLAYERS)
            .position(|c| c.client_id == client_id)
    }

    /// SESSION_START / resync co-op seat list for the configured board size.
    fn build_coop_slots_json(player_ids: &[String], size_index: u8) -> Value {
        let n = player_ids.len();
        let offsets = crate::coop::spawn_offsets(n);
        let (bw, bh) = board_dims(size_index);
        let cx = (bw / 2).max(2);
        let cy = bh / 2;
        let slots: Vec<Value> = player_ids
            .iter()
            .enumerate()
            .map(|(i, client_id)| {
                let oy = offsets.get(i).copied().unwrap_or(0);
                let mut y = cy + oy;
                if y < 1 {
                    y = 1;
                }
                if y >= bh - 1 {
                    y = bh - 2;
                }
                json!({
                    "clientId": client_id,
                    "slot": i,
                    "oy": oy,
                    "x": cx,
                    "y": y,
                    "dir": "RIGHT",
                    "playerNumber": i + 1,
                    "boardWidth": bw,
                    "boardHeight": bh,
                })
            })
            .collect();
        json!(slots)
    }

    fn current_coop_authority(&self) -> CoopAuthority {
        self.coop_authority.unwrap_or(CoopAuthority::ServerSim)
    }

    fn native_active(&self) -> bool {
        self.mode == Mode::Coop
            && self.session_active
            && self.coop_authority == Some(CoopAuthority::NativeRelay)
    }

    fn active_board_dims(&self) -> (i32, i32) {
        let settings = self.coop_run_settings.as_ref().unwrap_or(&self.settings);
        let size = settings.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        board_dims(size)
    }

    fn native_metadata_payload(&self, resync: bool) -> Value {
        let authority = self.current_coop_authority();
        let settings = self.coop_run_settings.as_ref().unwrap_or(&self.settings);
        let size = settings.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let (width, height) = board_dims(size);
        let (board_revision, board_ready, mode_key, speed_epoch, effective_speed) = self
            .native_relay
            .as_ref()
            .map(|s| {
                (
                    s.board_revision,
                    s.board_ready,
                    s.mode_key.clone(),
                    s.speed_epoch,
                    s.effective_speed.clone(),
                )
            })
            .unwrap_or((
                0,
                true,
                None,
                0,
                settings.get("speed").cloned().unwrap_or(Value::Null),
            ));
        json!({
            "mode": "coop",
            "authority": authority.as_str(),
            "serverAuth": authority.server_auth(),
            "generation": self.coop_generation,
            "settings": settings,
            "slots": Self::build_coop_slots_json(&self.coop_slots, size),
            "boardWidth": width,
            "boardHeight": height,
            "collectablesOwnerId": self.collectables_owner,
            "boardRevision": board_revision,
            "boardReady": board_ready,
            "modeKey": mode_key,
            "speedEpoch": speed_epoch,
            "effectiveSpeed": effective_speed,
            "timerStartedAtMs": self.coop_timer_started_at_ms,
            "resync": resync,
        })
    }

    fn send_board_init_request(&mut self) {
        if !self.native_active() {
            return;
        }
        let Some(initializer) = self
            .native_relay
            .as_ref()
            .and_then(|s| s.initializer_id.clone())
        else {
            return;
        };
        self.collectables_owner = Some(initializer.clone());
        self.push_broadcast(Envelope::new(
            "COOP_BOARD_INIT",
            json!({
                "generation": self.coop_generation,
                "initializerClientId": initializer,
                "collectablesOwnerId": self.collectables_owner,
                "baseRevision": 0,
            }),
        ));
    }

    fn next_native_initializer(&self) -> Option<String> {
        self.coop_slots.iter().find_map(|id| {
            let connected = self.clients.contains_key(id);
            let alive = self.coop_alive.get(id).copied().unwrap_or(false);
            if connected && alive {
                Some(id.clone())
            } else {
                None
            }
        })
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
                let coop_slot = self.coop_slot_of(&c.client_id);
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
                    "coopSlot": coop_slot,
                    "playerNumber": coop_slot.map(|s| s + 1),
                })
            })
            .collect();
        list.sort_by_key(|v| v["joinOrder"].as_u64().unwrap_or(0));
        json!({
            "roomCode": self.code,
            "mode": self.mode.as_str(),
            "adminId": self.admin_id,
            "durationMin": self.duration_min,
            "raceGoal": self.race_goal.as_str(),
            "raceGoalLabel": self.race_goal.label(),
            "sessionActive": self.session_active,
            "attemptExpired": self.attempt_expired,
            "allowNewRuns": self.allow_new_runs,
            "finishOngoingRuns": self.finish_ongoing_runs,
            "allPlayersReady": self.all_players_ready(),
            "collectablesOwnerId": self.collectables_owner,
            "coopAuthority": self.coop_authority.map(|a| a.as_str()),
            "coopGeneration": self.coop_generation,
            "leaderClientId": self.race_leader_id(),
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
        if !self.clients.contains_key(client_id) {
            return;
        }
        let was_frozen_coop_seat = self.mode == Mode::Coop
            && self.session_active
            && self.coop_slots.iter().any(|id| id == client_id);
        let native_frozen_seat =
            was_frozen_coop_seat && self.current_coop_authority() == CoopAuthority::NativeRelay;
        let server_sim_frozen_seat = was_frozen_coop_seat
            && self.current_coop_authority() == CoopAuthority::ServerSim
            && self.coop_alive.get(client_id).copied().unwrap_or(false);
        if native_frozen_seat {
            let _ = self.mark_native_seat_dead(client_id, "disconnect", None);
        }

        self.clients.remove(client_id);
        self.race_scores.remove(client_id);
        self.race_boards.remove(client_id);

        if server_sim_frozen_seat {
            // Disconnect = die: mark sim snake dead, keep corpse in STATE path
            self.coop_alive.insert(client_id.to_string(), false);
            if let Some(ref mut game) = self.coop {
                if let Some(s) = game.snakes.iter_mut().find(|s| s.client_id == client_id) {
                    s.alive = false;
                    let body = json!(s.body);
                    self.coop_snakes.insert(
                        client_id.to_string(),
                        json!({
                            "clientId": client_id,
                            "body": body,
                            "alive": false,
                        }),
                    );
                }
            }
            self.push_broadcast(Envelope::new(
                "COOP_PLAYER_DEAD",
                json!({
                    "clientId": client_id,
                    "body": self.coop_snakes.get(client_id).and_then(|s| s.get("body")).cloned(),
                    "reason": "disconnect",
                }),
            ));
            if let Some(ref game) = self.coop {
                self.push_broadcast(Envelope::new("COOP_STATE", game.snapshot()));
            }
        } else if !native_frozen_seat {
            self.coop_snakes.remove(client_id);
            self.coop_alive.remove(client_id);
        }

        if !native_frozen_seat && self.collectables_owner.as_deref() == Some(client_id) {
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
            self.clear_coop_run_state();
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
            "SET_RACE_GOAL" | "SET_VERSUS_GOAL" => self.cmd_set_race_goal(from, &env.payload),
            "READY" => self.cmd_ready(from, &env.payload),
            "COLOR_CLAIM" => self.cmd_color_claim(from, &env.payload),
            "MODE_CHANGE" => self.cmd_mode_change(from, &env.payload),
            "SETTINGS_SYNC" => self.cmd_settings_sync(from, &env.payload),
            "PLAY_SYNC" => self.cmd_play_sync(from, &env.payload),
            "SESSION_START" => self.cmd_session_start(from, &env.payload),
            "SESSION_END" => self.cmd_session_end(from, &env.payload),
            "INPUT" | "COOP_INPUT" => self.cmd_input(from, &env.payload),
            "SCORE_PULSE" => self.cmd_score_pulse(from, &env.payload),
            "ADMIN_TRANSFER" => self.cmd_admin_transfer(from, &env.payload),
            "RESYNC_REQUEST" => self.cmd_resync(from),
            "BOARD_DELTA" | "BOARD_SNAPSHOT" => self.cmd_board(from, &env.payload),
            "SPECTATE_FOCUS" => self.cmd_spectate_focus(from, &env.payload),
            "SNAKE_DELTA" => self.cmd_snake_delta(from, &env.payload),
            "COLLECTABLES_DELTA" => self.cmd_collectables_delta(from, &env.payload),
            "COOP_PLAYER_DEAD" => self.cmd_coop_player_dead(from, &env.payload),
            "COOP_GOAL" => self.cmd_coop_goal(from, &env.payload),
            "COOP_SPEED_TRANSITION" => self.cmd_coop_speed_transition(from, &env.payload),
            "COOP_BOARD_INIT" | "COOP_BOARD_READY" => Err("server_owned_message".into()),
            "PING" => {
                self.push_to(from, Envelope::new("PONG", json!({})));
                Ok(())
            }
            "HELLO" => Ok(()), // already joined
            "SET_DISPLAY_NAME" => self.cmd_set_display_name(from, &env.payload),
            other => {
                warn!(roomId = %self.code, clientId = %from, msg_type = other, event = "unknown_type");
                Err(format!("unknown_type:{other}"))
            }
        };
        if let Err(e) = result {
            self.push_error(from, &e, &e);
        }
    }

    /// Any joined client may rename themselves; empty clears to color fallback.
    fn cmd_set_display_name(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let raw = payload
            .get("displayName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let cleaned = sanitize_client_display_name(raw);
        let client = self
            .clients
            .get_mut(from)
            .ok_or_else(|| "unknown_client".to_string())?;
        client.display_name = cleaned;
        self.broadcast_roster();
        Ok(())
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
        if role == Role::Spectator
            && self.mode == Mode::Coop
            && self.session_active
            && self.coop_slots.iter().any(|id| id == &target)
        {
            match self.current_coop_authority() {
                CoopAuthority::NativeRelay => {
                    self.mark_native_seat_dead(&target, "demotion", None)?;
                }
                CoopAuthority::ServerSim => {
                    self.mark_server_sim_seat_dead(&target, "demotion");
                }
            }
        }
        if role == Role::Player {
            let count = self
                .clients
                .values()
                .filter(|c| c.role == Role::Player)
                .count();
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
        if self.mode == Mode::Coop
            && self.session_active
            && self.coop_slots.iter().any(|id| id == &target)
        {
            match self.current_coop_authority() {
                CoopAuthority::NativeRelay => {
                    self.mark_native_seat_dead(&target, "kick", None)?;
                }
                CoopAuthority::ServerSim => self.mark_server_sim_seat_dead(&target, "kick"),
            }
        }
        info!(roomId = %self.code, clientId = %target, event = "kick");
        self.push_to(
            &target,
            Envelope::new(
                "ERROR",
                json!({"code":"kicked","message":"You were kicked"}),
            ),
        );
        // Mark for disconnect via special outbox target
        self.push_broadcast(Envelope::new("KICK", json!({"clientId": target})));
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

    fn cmd_set_race_goal(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        let raw = payload
            .get("goal")
            .and_then(|v| v.as_str())
            .ok_or("bad_race_goal")?;
        let goal = RaceGoal::parse(raw).ok_or("bad_race_goal")?;
        self.race_goal = goal;
        for entry in self.race_scores.values_mut() {
            entry.best_goal_time_ms = None;
            entry.goal_completed = false;
            // Re-evaluate from current live score against the new goal
            Self::apply_goal_progress(goal, entry, entry.score, entry.time_ms, false);
        }
        info!(roomId = %self.code, goal = goal.as_str(), event = "set_race_goal");
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_ready(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let client = self.clients.get_mut(from).ok_or("unknown_client")?;
        if client.role != Role::Player {
            return Err("spectators_cannot_ready".into());
        }
        let ready = payload
            .get("ready")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
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
        self.attempt_deadline = None;
        // Lobby can Start again; keep last-match scores until SESSION_START.
        self.allow_new_runs = true;
        if !self.race_scores.is_empty() {
            // Preserve final results for HUD/roster until the next Start match.
            self.attempt_expired = true;
        } else {
            self.attempt_expired = false;
        }
        // Full co-op teardown — must match sim end (timer/seated/alive), not a
        // partial clear that leaves the room "mid-run" for the next lobby.
        self.clear_coop_run_state();
        // Do not clear race_scores / race_boards here — SESSION_START resets them.
        self.push_broadcast(Envelope::new("SESSION_END", json!({"reason":"aborted"})));
    }

    /// Drop every live co-op field so roster/resync look like lobby, not mid-match.
    fn clear_coop_run_state(&mut self) {
        self.session_active = false;
        self.coop = None;
        self.coop_snakes.clear();
        self.coop_collectables = None;
        self.collectables_owner = None;
        self.coop_alive.clear();
        self.coop_seated.clear();
        self.coop_timer_started_at_ms = None;
        self.coop_slots.clear();
        self.coop_accum_ms = 0;
        self.coop_authority = None;
        self.coop_run_settings = None;
        self.native_relay = None;
        for c in self.clients.values_mut() {
            c.ready = false;
        }
    }

    /// Finish a co-op run (ALL_APPLES / ALL_DEAD / stuck sim) and notify clients.
    fn end_coop_session(&mut self, reason: &str) {
        info!(roomId = %self.code, reason = %reason, event = "coop_session_end");
        self.clear_coop_run_state();
        self.push_broadcast(Envelope::new("SESSION_END", json!({ "reason": reason })));
        self.broadcast_roster();
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
            .min_by_key(|c| (c.promote_order.unwrap_or(u64::MAX), c.join_order))
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

    /// After Race→Coop or demotion: rematch any duplicate player colors.
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
        // Mode switch drops prior race results (Start of a different game type)
        self.race_scores.clear();
        self.race_boards.clear();
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
        self.push_broadcast(Envelope::new("MODE_CHANGE", json!({"mode": mode.as_str()})));
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_settings_sync(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        self.require_admin(from)?;
        // `settings` is lobby state. The active generation always reads its
        // immutable `coop_run_settings` snapshot.
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
        if self.mode == Mode::Race && !self.allow_new_runs {
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
        if self.mode == Mode::Coop && self.session_active {
            return Err("session_active".into());
        }
        // Prefer settings bundled with Start match. Lobby settings may change
        // later, but this snapshot remains immutable for this generation.
        if let Some(settings) = payload.get("settings") {
            if settings.is_object() {
                self.settings = settings.clone();
            }
        }
        self.session_active = true;
        self.attempt_expired = false;
        self.allow_new_runs = true;
        // Fresh match — drop previous attempt results
        self.race_scores.clear();
        self.race_boards.clear();
        self.coop = None;
        self.coop_snakes.clear();
        self.coop_collectables = None;
        self.coop_alive.clear();
        self.coop_seated.clear();
        self.coop_timer_started_at_ms = None;
        self.coop_slots.clear();
        self.coop_authority = None;
        self.coop_run_settings = None;
        self.native_relay = None;
        if self.mode == Mode::Race {
            self.attempt_deadline =
                Some(Instant::now() + Duration::from_secs(self.duration_min as u64 * 60));
            self.collectables_owner = None;
            if let Some(flag) = payload.get("finishOngoingRuns").and_then(|v| v.as_bool()) {
                self.finish_ongoing_runs = flag;
            }
        } else {
            self.attempt_deadline = None;
            let player_ids: Vec<String> = self
                .ordered_coop_players()
                .into_iter()
                .take(MAX_COOP_PLAYERS)
                .map(|p| p.client_id.clone())
                .collect();
            for id in &player_ids {
                self.coop_alive.insert(id.clone(), true);
            }
            self.coop_slots = player_ids;
            self.coop_generation = self.coop_generation.saturating_add(1);
            let authority = if self.coop_native_relay_enabled {
                CoopAuthority::NativeRelay
            } else {
                CoopAuthority::ServerSim
            };
            self.coop_authority = Some(authority);
            self.coop_run_settings = Some(self.settings.clone());
            self.collectables_owner = self
                .admin_id
                .as_ref()
                .filter(|id| self.coop_slots.contains(id))
                .cloned()
                .or_else(|| self.coop_slots.first().cloned());
        }
        info!(roomId = %self.code, mode = self.mode.as_str(), event = "session_start");
        let mut start_payload = json!({
            "mode": self.mode.as_str(),
            "durationMin": self.duration_min,
            "raceGoal": self.race_goal.as_str(),
            "raceGoalLabel": self.race_goal.label(),
            "collectablesOwnerId": self.collectables_owner,
            "finishOngoingRuns": self.finish_ongoing_runs,
            "settings": self.settings,
        });
        if self.mode == Mode::Coop {
            let player_ids = self.coop_slots.clone();
            let cfg = CoopStartConfig::from_settings(
                self.coop_run_settings.as_ref().unwrap_or(&self.settings),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(1),
            );
            let size_index = cfg.size_index;
            let slots_json = Self::build_coop_slots_json(&player_ids, size_index);
            // Build (client_id, color_id, slot)
            let mut player_slots: Vec<(String, u8, u8)> = Vec::new();
            for (i, id) in player_ids.iter().enumerate() {
                let color = self
                    .clients
                    .get(id)
                    .and_then(|c| c.color_id)
                    .unwrap_or(i as u8);
                player_slots.push((id.clone(), color, i as u8));
            }
            start_payload["slots"] = slots_json;
            start_payload["generation"] = json!(self.coop_generation);
            start_payload["authority"] = json!(self.current_coop_authority().as_str());
            start_payload["serverAuth"] = json!(self.current_coop_authority().server_auth());
            start_payload["settings"] = self.coop_run_settings.clone().unwrap_or_else(|| json!({}));
            self.coop_accum_ms = 0;
            match self.current_coop_authority() {
                CoopAuthority::ServerSim => {
                    let game = CoopGame::new(&player_slots, cfg);
                    start_payload["intervalMs"] = json!(game.interval_ms());
                    start_payload["boardWidth"] = json!(game.width);
                    start_payload["boardHeight"] = json!(game.height);
                    start_payload["boardReady"] = json!(true);
                    start_payload["boardRevision"] = json!(0);
                    start_payload["speedEpoch"] = json!(0);
                    start_payload["effectiveSpeed"] = self
                        .coop_run_settings
                        .as_ref()
                        .and_then(|s| s.get("speed"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    start_payload["state"] = game.snapshot();
                    self.coop = Some(game);
                    // The simulation owns every pose from tick zero.
                    for id in &player_ids {
                        self.coop_seated.insert(id.clone(), true);
                    }
                }
                CoopAuthority::NativeRelay => {
                    let effective_speed = self
                        .coop_run_settings
                        .as_ref()
                        .and_then(|s| s.get("speed"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    self.native_relay = Some(NativeRelayState::new(
                        self.collectables_owner.clone(),
                        effective_speed,
                    ));
                    start_payload = self.native_metadata_payload(false);
                }
            }
        }
        self.push_broadcast(Envelope::new("SESSION_START", start_payload));
        // Start match → Play for every ready player (Race and Co-op).
        self.push_broadcast(Envelope::new("PLAY_SYNC", json!({})));
        if self.mode == Mode::Coop && self.current_coop_authority() == CoopAuthority::ServerSim {
            if let Some(ref g) = self.coop {
                self.push_broadcast(Envelope::new("COOP_STATE", g.snapshot()));
            }
        } else if self.native_active() {
            self.send_board_init_request();
        }
        self.broadcast_roster();
        Ok(())
    }

    fn cmd_input(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        if self.mode != Mode::Coop {
            return Err("not_coop".into());
        }
        if !self.session_active {
            return Ok(());
        }
        if self.current_coop_authority() == CoopAuthority::NativeRelay {
            return Err("native_relay_uses_pose".into());
        }
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player {
            return Err("not_player".into());
        }
        let dir_str = payload
            .get("dir")
            .and_then(|v| v.as_str())
            .ok_or("missing_dir")?;
        let dir = Dir::from_str(dir_str).ok_or("bad_dir")?;
        // Arm shared timer on first input
        if self.coop_timer_started_at_ms.is_none() {
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
        if let Some(ref mut game) = self.coop {
            game.set_input(from, dir);
        }
        Ok(())
    }

    fn require_native_sender(&self, from: &str, payload: &Value) -> Result<(u64, u64), String> {
        if !self.native_active() {
            return Err("not_native_relay".into());
        }
        if !self.coop_slots.iter().any(|id| id == from) || !self.clients.contains_key(from) {
            return Err("not_frozen_seat".into());
        }
        let generation = payload
            .get("generation")
            .and_then(|v| v.as_u64())
            .ok_or("missing_generation")?;
        if generation != self.coop_generation {
            return Err("stale_generation".into());
        }
        let event_seq = payload
            .get("eventSeq")
            .and_then(|v| v.as_u64())
            .filter(|v| *v > 0)
            .ok_or("bad_event_seq")?;
        let last = self
            .native_relay
            .as_ref()
            .and_then(|s| s.last_event_seq.get(from))
            .copied()
            .unwrap_or(0);
        if event_seq <= last {
            return Err("stale_event_seq".into());
        }
        Ok((generation, event_seq))
    }

    fn validate_native_body(&self, body: &Value) -> Result<(), String> {
        let cells = body.as_array().ok_or("bad_body")?;
        if cells.is_empty() || cells.len() > MAX_NATIVE_BODY_LEN {
            return Err("bad_body_length".into());
        }
        let (width, height) = self.active_board_dims();
        for cell in cells {
            let x = cell
                .get("x")
                .and_then(|v| v.as_i64())
                .ok_or("bad_body_cell")?;
            let y = cell
                .get("y")
                .and_then(|v| v.as_i64())
                .ok_or("bad_body_cell")?;
            if x < 0 || y < 0 || x >= i64::from(width) || y >= i64::from(height) {
                return Err("body_out_of_bounds".into());
            }
        }
        Ok(())
    }

    fn validate_native_board(&self, payload: &Value) -> Result<(), String> {
        const ENTITY_KEYS: [&str; 11] = [
            "apples",
            "collectables",
            "walls",
            "keys",
            "boxes",
            "goals",
            "mines",
            "statues",
            "bridges",
            "gates",
            "arrows",
        ];
        if payload
            .get("apples")
            .or_else(|| payload.get("collectables"))
            .and_then(Value::as_array)
            .is_none()
        {
            return Err("missing_collectables".into());
        }
        let (width, height) = self.active_board_dims();
        let mut entity_count = 0usize;
        for key in ENTITY_KEYS {
            let Some(value) = payload.get(key) else {
                continue;
            };
            let entities = value.as_array().ok_or("bad_board_entities")?;
            entity_count = entity_count.saturating_add(entities.len());
            if entity_count > MAX_NATIVE_BODY_LEN {
                return Err("board_too_large".into());
            }
            for entity in entities {
                let Some(x_value) = entity.get("x") else {
                    continue;
                };
                let Some(y_value) = entity.get("y") else {
                    continue;
                };
                let x = x_value.as_i64().ok_or("bad_board_cell")?;
                let y = y_value.as_i64().ok_or("bad_board_cell")?;
                if x < 0 || y < 0 || x >= i64::from(width) || y >= i64::from(height) {
                    return Err("board_cell_out_of_bounds".into());
                }
            }
        }
        Ok(())
    }

    fn validate_native_pose_bodies(&self, payload: &Value) -> Result<(), String> {
        self.validate_native_body(payload.get("body").ok_or("missing_body")?)?;
        if let Some(body2) = payload.get("body2").filter(|v| !v.is_null()) {
            self.validate_native_body(body2)?;
        }
        Ok(())
    }

    fn normalize_native_mode_key(value: &Value) -> Result<String, String> {
        let key = value.as_str().ok_or("bad_mode_key")?.trim();
        if key.is_empty()
            || key.len() > MAX_NATIVE_MODE_KEY_LEN
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'+'))
        {
            return Err("bad_mode_key".into());
        }
        Ok(key.to_ascii_lowercase())
    }

    fn mode_key_has(mode_key: &str, part: &str) -> bool {
        mode_key.split('+').any(|item| item == part)
    }

    fn normalize_native_dir(
        object: &mut serde_json::Map<String, Value>,
        key: &str,
        allow_none: bool,
        required: bool,
    ) -> Result<(), String> {
        let Some(value) = object.get(key) else {
            return if required {
                Err(format!("missing_{key}"))
            } else {
                Ok(())
            };
        };
        if allow_none && value.is_null() {
            object.insert(key.into(), json!("NONE"));
            return Ok(());
        }
        let direction = value.as_str().ok_or_else(|| format!("bad_{key}"))?;
        let normalized = direction.to_ascii_uppercase();
        let valid = matches!(normalized.as_str(), "UP" | "DOWN" | "LEFT" | "RIGHT")
            || (allow_none && normalized == "NONE");
        if !valid {
            return Err(format!("bad_{key}"));
        }
        object.insert(key.into(), json!(normalized));
        Ok(())
    }

    fn validate_native_cell(&self, value: &Value, error: &str) -> Result<(), String> {
        let cell = value.as_object().ok_or(error)?;
        let x = cell.get("x").and_then(Value::as_i64).ok_or(error)?;
        let y = cell.get("y").and_then(Value::as_i64).ok_or(error)?;
        let (width, height) = self.active_board_dims();
        if x < 0 || y < 0 || x >= i64::from(width) || y >= i64::from(height) {
            return Err(error.into());
        }
        Ok(())
    }

    fn validate_native_visual_value(value: &Value, depth: usize) -> Result<(), String> {
        if depth > 3 {
            return Err("visual_metadata_too_deep".into());
        }
        match value {
            Value::String(text) if text.len() > MAX_NATIVE_VISUAL_STRING_LEN => {
                Err("visual_string_too_long".into())
            }
            Value::Array(items) if items.len() > 32 => Err("visual_array_too_large".into()),
            Value::Array(items) => {
                for item in items {
                    Self::validate_native_visual_value(item, depth + 1)?;
                }
                Ok(())
            }
            Value::Object(fields) if fields.len() > 16 => Err("visual_object_too_large".into()),
            Value::Object(fields) => {
                for value in fields.values() {
                    Self::validate_native_visual_value(value, depth + 1)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn validate_native_visual_metadata(payload: &Value) -> Result<(), String> {
        let object = payload.as_object().ok_or("bad_pose")?;
        for (key, value) in object {
            let lower = key.to_ascii_lowercase();
            if lower.contains("color") || lower.contains("style") {
                Self::validate_native_visual_value(value, 0)?;
            } else if let Value::String(text) = value {
                if text.len() > MAX_NATIVE_VISUAL_STRING_LEN {
                    return Err("pose_string_too_long".into());
                }
            }
        }
        Ok(())
    }

    fn validate_native_segment_flags(
        payload: &Value,
        key: &str,
        body_key: &str,
    ) -> Result<(), String> {
        let Some(flags) = payload.get(key) else {
            return Ok(());
        };
        let flags = flags.as_array().ok_or("bad_segment_flags")?;
        let body_len = payload
            .get(body_key)
            .and_then(Value::as_array)
            .map(Vec::len)
            .ok_or("bad_segment_flags")?;
        if flags.len() != body_len
            || flags.iter().any(|flag| {
                !matches!(flag, Value::Bool(_)) && flag.as_u64().is_none_or(|value| value > 1)
            })
        {
            return Err("bad_segment_flags".into());
        }
        Ok(())
    }

    fn validate_native_render_contract(payload: &Value) -> Result<(), String> {
        Self::validate_native_segment_flags(payload, "segmentFlags", "body")?;
        Self::validate_native_segment_flags(payload, "segmentFlags2", "body2")?;
        for (first, second) in [("Sc2", "Yc2"), ("color1_2", "color2_2")] {
            if payload.get(first).is_some() != payload.get(second).is_some() {
                return Err("incomplete_companion_style".into());
            }
        }
        for key in ["headLight", "headLight2"] {
            if let Some(value) = payload.get(key) {
                let light = value.as_f64().ok_or("bad_head_light")?;
                if !light.is_finite() || !(0.0..=64.0).contains(&light) {
                    return Err("bad_head_light".into());
                }
            }
        }
        for key in ["colorId", "colorId2"] {
            if let Some(value) = payload.get(key).filter(|value| !value.is_null()) {
                if value.as_u64().is_none_or(|color| color > 255) {
                    return Err("bad_color_id".into());
                }
            }
        }
        Ok(())
    }

    fn validate_native_turns(
        &self,
        from: &str,
        clean: &mut Value,
    ) -> Result<(u64, Vec<Value>), String> {
        let incoming = match clean.get("turns") {
            Some(value) => value.as_array().ok_or("bad_turns")?.clone(),
            None => Vec::new(),
        };
        if incoming.len() > MAX_NATIVE_TURNS {
            return Err("too_many_turns".into());
        }

        let state = self.native_relay.as_ref().ok_or("not_native_relay")?;
        let previous_highest = state.last_turn_seq.get(from).copied().unwrap_or(0);
        let previous = state.turn_journals.get(from).cloned().unwrap_or_default();
        let previous_by_seq: HashMap<u64, Value> = previous
            .iter()
            .filter_map(|entry| {
                entry
                    .get("turnSeq")
                    .and_then(Value::as_u64)
                    .map(|seq| (seq, entry.clone()))
            })
            .collect();

        let mut normalized = Vec::with_capacity(incoming.len());
        let mut prior_in_payload = 0;
        let mut expected_new = previous_highest.saturating_add(1);
        for mut entry in incoming {
            let fields = entry.as_object_mut().ok_or("bad_turn")?;
            const TURN_KEYS: [&str; 5] = ["turnSeq", "at", "fromDir", "toDir", "moveSeq"];
            if fields.len() != TURN_KEYS.len()
                || !TURN_KEYS.iter().all(|key| fields.contains_key(*key))
            {
                return Err("bad_turn_shape".into());
            }
            let turn_seq = fields
                .get("turnSeq")
                .and_then(Value::as_u64)
                .filter(|seq| *seq > 0)
                .ok_or("bad_turn_seq")?;
            if turn_seq <= prior_in_payload {
                return Err("turns_not_ordered".into());
            }
            prior_in_payload = turn_seq;
            fields
                .get("moveSeq")
                .and_then(Value::as_u64)
                .ok_or("bad_turn_move_seq")?;
            let at = fields.get("at").ok_or("bad_turn_cell")?;
            if at.as_object().is_none_or(|cell| {
                cell.len() != 2 || !cell.contains_key("x") || !cell.contains_key("y")
            }) {
                return Err("bad_turn_cell".into());
            }
            self.validate_native_cell(at, "bad_turn_cell")?;
            Self::normalize_native_dir(fields, "fromDir", false, true)?;
            Self::normalize_native_dir(fields, "toDir", false, true)?;

            if turn_seq <= previous_highest {
                let old = previous_by_seq.get(&turn_seq).ok_or("stale_turn_overlap")?;
                if old != &entry {
                    return Err("turn_overlap_mismatch".into());
                }
            } else {
                if turn_seq != expected_new {
                    return Err("turn_suffix_not_contiguous".into());
                }
                expected_new = expected_new.saturating_add(1);
            }
            normalized.push(entry);
        }
        if let Some(highest) = normalized
            .last()
            .and_then(|entry| entry.get("turnSeq"))
            .and_then(Value::as_u64)
        {
            if highest < previous_highest {
                return Err("turn_seq_regression".into());
            }
        }

        let mut merged = previous;
        for entry in normalized {
            let seq = entry["turnSeq"].as_u64().unwrap_or(0);
            if seq > previous_highest {
                merged.push(entry);
            }
        }
        if merged.len() > MAX_NATIVE_TURNS {
            merged.drain(0..merged.len() - MAX_NATIVE_TURNS);
        }
        let highest = merged
            .last()
            .and_then(|entry| entry.get("turnSeq"))
            .and_then(Value::as_u64)
            .unwrap_or(previous_highest);
        clean
            .as_object_mut()
            .ok_or("bad_pose")?
            .insert("turns".into(), Value::Array(merged.clone()));
        Ok((highest, merged))
    }

    fn cmd_snake_delta(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        if self.mode != Mode::Coop || !self.session_active {
            return Ok(());
        }
        if self.current_coop_authority() == CoopAuthority::ServerSim {
            // Preserve compatibility with old clients; simulation remains authority.
            return Ok(());
        }
        let (generation, event_seq) = self.require_native_sender(from, payload)?;
        let pose_seq = payload
            .get("poseSeq")
            .and_then(|v| v.as_u64())
            .filter(|v| *v > 0)
            .ok_or("bad_pose_seq")?;
        let last_pose = self
            .native_relay
            .as_ref()
            .and_then(|s| s.last_pose_seq.get(from))
            .copied()
            .unwrap_or(0);
        if pose_seq <= last_pose {
            return Err("stale_pose_seq".into());
        }
        if serde_json::to_vec(payload).map_err(|_| "bad_pose")?.len() > MAX_NATIVE_POSE_BYTES {
            return Err("pose_too_large".into());
        }
        let seated = payload
            .get("seated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let moved = payload
            .get("moved")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if moved && !seated {
            return Err("moved_before_seated".into());
        }
        let (board_ready, canonical_mode_key, last_move_seq) = self
            .native_relay
            .as_ref()
            .map(|s| {
                (
                    s.board_ready,
                    s.mode_key.clone(),
                    s.last_move_seq.get(from).copied(),
                )
            })
            .ok_or("not_native_relay")?;
        if moved && !board_ready {
            return Err("board_not_ready".into());
        }
        if !self.coop_alive.get(from).copied().unwrap_or(false) {
            return Err("seat_dead".into());
        }

        let mut clean = payload.clone();
        Self::validate_native_visual_metadata(&clean)?;
        self.validate_native_pose_bodies(&clean)?;
        Self::validate_native_render_contract(&clean)?;

        let supplied_mode_key = clean
            .get("modeKey")
            .filter(|value| !value.is_null())
            .map(Self::normalize_native_mode_key)
            .transpose()?;
        if board_ready {
            let canonical = canonical_mode_key
                .as_deref()
                .ok_or("missing_canonical_mode")?;
            if supplied_mode_key.as_deref() != Some(canonical) {
                return Err("mode_key_mismatch".into());
            }
        }

        let body2_present = clean.get("body2").is_some_and(|value| !value.is_null());
        if board_ready {
            let yin_yang = canonical_mode_key
                .as_deref()
                .is_some_and(|key| Self::mode_key_has(key, "yin_yang"));
            if yin_yang && !body2_present {
                return Err("yin_yang_body2_required".into());
            }
            if !yin_yang && body2_present {
                return Err("body2_not_allowed".into());
            }
        }

        let move_seq = clean.get("moveSeq").and_then(Value::as_u64);
        if board_ready && move_seq.is_none() {
            return Err("missing_moveSeq".into());
        }
        if let (Some(current), Some(previous)) = (move_seq, last_move_seq) {
            if current < previous {
                return Err("move_seq_regression".into());
            }
        }
        for key in ["fromHead", "toHead"] {
            match clean.get(key).filter(|value| !value.is_null()) {
                Some(value) => self.validate_native_cell(value, &format!("bad_{key}"))?,
                None if board_ready => return Err(format!("missing_{key}")),
                None => {}
            }
        }

        {
            let object = clean.as_object_mut().ok_or("bad_pose")?;
            Self::normalize_native_dir(object, "dir", false, true)?;
            Self::normalize_native_dir(object, "movementDir", false, board_ready)?;
            Self::normalize_native_dir(object, "headDir", false, board_ready)?;
            Self::normalize_native_dir(object, "transitionDir", true, board_ready)?;
            if body2_present {
                Self::normalize_native_dir(object, "dir2", false, false)?;
                Self::normalize_native_dir(object, "movementDir2", false, true)?;
                Self::normalize_native_dir(object, "headDir2", false, true)?;
                Self::normalize_native_dir(object, "transitionDir2", true, true)?;
            } else {
                Self::normalize_native_dir(object, "dir2", false, false)?;
                Self::normalize_native_dir(object, "movementDir2", false, false)?;
                Self::normalize_native_dir(object, "headDir2", false, false)?;
                Self::normalize_native_dir(object, "transitionDir2", true, false)?;
            }
            if let Some(mode_key) = supplied_mode_key {
                object.insert("modeKey".into(), json!(mode_key));
            }
        }
        let (highest_turn_seq, turn_journal) = self.validate_native_turns(from, &mut clean)?;

        let object = clean.as_object_mut().ok_or("bad_pose")?;
        object.insert("clientId".into(), json!(from));
        object.insert("generation".into(), json!(generation));
        object.insert("eventSeq".into(), json!(event_seq));
        object.insert("poseSeq".into(), json!(pose_seq));
        object.insert("alive".into(), json!(true));
        object.insert("turns".into(), Value::Array(turn_journal.clone()));
        let state = self.native_relay.as_mut().ok_or("not_native_relay")?;
        state.last_event_seq.insert(from.to_string(), event_seq);
        state.last_pose_seq.insert(from.to_string(), pose_seq);
        if let Some(move_seq) = move_seq {
            state.last_move_seq.insert(from.to_string(), move_seq);
        }
        state
            .last_turn_seq
            .insert(from.to_string(), highest_turn_seq);
        state.turn_journals.insert(from.to_string(), turn_journal);
        state.poses.insert(from.to_string(), clean.clone());
        self.coop_snakes.insert(from.to_string(), clean.clone());
        if seated {
            self.coop_seated.insert(from.to_string(), true);
        }
        self.push_broadcast(Envelope::new("SNAKE_DELTA", clean));

        if moved && seated && self.coop_timer_started_at_ms.is_none() {
            let ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            self.coop_timer_started_at_ms = Some(ms);
            self.push_broadcast(Envelope::new(
                "COOP_TIMER_START",
                json!({
                    "generation": self.coop_generation,
                    "timerStartedAtMs": ms,
                    "clientId": from,
                }),
            ));
        }
        Ok(())
    }

    fn cmd_collectables_delta(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        if self.mode != Mode::Coop || !self.session_active {
            return Ok(());
        }
        if self.current_coop_authority() == CoopAuthority::ServerSim {
            return Ok(());
        }
        let (generation, event_seq) = self.require_native_sender(from, payload)?;
        let state = self.native_relay.as_ref().ok_or("not_native_relay")?;
        if state.initializer_id.as_deref() != Some(from) {
            return Err("not_board_initializer".into());
        }
        if state.board_revision != 0 || state.board_ready {
            return Err("runtime_board_updates_disabled".into());
        }
        if payload.get("initial").and_then(|v| v.as_bool()) != Some(true)
            || payload.get("baseRevision").and_then(|v| v.as_u64()) != Some(0)
        {
            return Err("initial_board_required".into());
        }
        if !self.coop_seated.get(from).copied().unwrap_or(false) {
            return Err("initializer_not_seated".into());
        }
        let mode_key =
            Self::normalize_native_mode_key(payload.get("modeKey").ok_or("missing_mode_key")?)?;
        self.validate_native_board(payload)?;
        let mut clean = payload.clone();
        let object = clean.as_object_mut().ok_or("bad_board")?;
        object.insert("clientId".into(), json!(from));
        object.insert("generation".into(), json!(generation));
        object.insert("eventSeq".into(), json!(event_seq));
        object.insert("revision".into(), json!(1));
        object.insert("initial".into(), json!(true));
        object.insert("modeKey".into(), json!(mode_key));
        let state = self.native_relay.as_mut().ok_or("not_native_relay")?;
        state.last_event_seq.insert(from.to_string(), event_seq);
        state.board_revision = 1;
        state.board_ready = true;
        state.mode_key = Some(mode_key.clone());
        state.board_snapshot = Some(clean.clone());
        // Pre-board poses establish seating only. They are not board-ready
        // render state and may have been scraped before the canonical mode was
        // available, so never replay them after revision 1.
        state.poses.clear();
        self.coop_snakes.clear();
        self.coop_collectables = Some(clean.clone());
        self.push_broadcast(Envelope::new("COLLECTABLES_DELTA", clean));
        self.push_broadcast(Envelope::new(
            "COOP_BOARD_READY",
            json!({
                "generation": self.coop_generation,
                "revision": 1,
                "collectablesOwnerId": from,
                "modeKey": mode_key,
            }),
        ));
        Ok(())
    }

    fn cmd_coop_player_dead(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        if self.mode != Mode::Coop || !self.session_active {
            return Ok(());
        }
        if self.current_coop_authority() == CoopAuthority::ServerSim {
            return Ok(());
        }
        if self.coop_slots.iter().any(|id| id == from)
            && !self.coop_alive.get(from).copied().unwrap_or(false)
        {
            // Death is idempotent, including a retry with the same eventSeq.
            return Ok(());
        }
        let (generation, event_seq) = self.require_native_sender(from, payload)?;
        if !self
            .native_relay
            .as_ref()
            .map(|s| s.board_ready)
            .unwrap_or(false)
        {
            return Err("board_not_ready".into());
        }
        if !self.coop_seated.get(from).copied().unwrap_or(false) {
            return Err("seat_not_seated".into());
        }
        if let Some(body) = payload.get("body") {
            self.validate_native_body(body)?;
        }
        if let Some(body2) = payload.get("body2").filter(|v| !v.is_null()) {
            self.validate_native_body(body2)?;
        }
        let reason = payload
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("native");
        self.mark_native_seat_dead(from, reason, Some((generation, event_seq, payload.clone())))?;
        Ok(())
    }

    fn cmd_coop_goal(&mut self, from: &str, _payload: &Value) -> Result<(), String> {
        // Plan 1: all-apples is decided by the server sim, not clients.
        let _ = from;
        Ok(())
    }

    fn cmd_coop_speed_transition(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let source_event_id = payload
            .get("sourceEventId")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty() && v.len() <= 128)
            .ok_or("bad_source_event_id")?
            .to_string();
        if self.native_active()
            && payload.get("generation").and_then(|v| v.as_u64()) == Some(self.coop_generation)
            && self
                .native_relay
                .as_ref()
                .map(|s| s.speed_sources.contains(&source_event_id))
                .unwrap_or(false)
        {
            return Ok(());
        }
        let (generation, event_seq) = self.require_native_sender(from, payload)?;
        if !self
            .native_relay
            .as_ref()
            .map(|s| s.board_ready)
            .unwrap_or(false)
        {
            return Err("board_not_ready".into());
        }
        let transition = payload.get("transition").unwrap_or(payload);
        let kind = transition
            .get("type")
            .or_else(|| transition.get("kind"))
            .and_then(|v| v.as_str())
            .ok_or("bad_speed_transition")?;

        let state = self.native_relay.as_mut().ok_or("not_native_relay")?;
        let effective = match kind {
            "set" => transition
                .get("value")
                .or_else(|| payload.get("effectiveSpeed"))
                .cloned()
                .ok_or("missing_speed_value")?,
            "toggle" => match &state.effective_speed {
                Value::Bool(value) => json!(!value),
                _ => payload
                    .get("effectiveSpeed")
                    .cloned()
                    .ok_or("missing_speed_value")?,
            },
            _ => return Err("bad_speed_transition".into()),
        };
        state.last_event_seq.insert(from.to_string(), event_seq);
        state.speed_sources.insert(source_event_id.clone());
        state.speed_epoch = state.speed_epoch.saturating_add(1);
        state.effective_speed = effective.clone();
        let speed_epoch = state.speed_epoch;
        self.push_broadcast(Envelope::new(
            "COOP_SPEED_TRANSITION",
            json!({
                "generation": generation,
                "eventSeq": event_seq,
                "clientId": from,
                "sourceEventId": source_event_id,
                "speedEpoch": speed_epoch,
                "transition": transition,
                "effectiveSpeed": effective,
            }),
        ));
        Ok(())
    }

    fn mark_native_seat_dead(
        &mut self,
        client_id: &str,
        reason: &str,
        event: Option<(u64, u64, Value)>,
    ) -> Result<(), String> {
        if !self.native_active() || !self.coop_slots.iter().any(|id| id == client_id) {
            return Ok(());
        }
        if !self.coop_alive.get(client_id).copied().unwrap_or(false) {
            return Ok(());
        }

        let mut corpse = event
            .as_ref()
            .map(|(_, _, payload)| payload.clone())
            .or_else(|| {
                self.native_relay
                    .as_ref()
                    .and_then(|s| s.poses.get(client_id).cloned())
            })
            .unwrap_or_else(|| json!({}));
        let object = corpse.as_object_mut().ok_or("bad_death")?;
        object.insert("clientId".into(), json!(client_id));
        object.insert("generation".into(), json!(self.coop_generation));
        object.insert("alive".into(), json!(false));
        object.insert("reason".into(), json!(reason));
        if let Some((_, event_seq, _)) = event {
            object.insert("eventSeq".into(), json!(event_seq));
            if let Some(state) = self.native_relay.as_mut() {
                state
                    .last_event_seq
                    .insert(client_id.to_string(), event_seq);
            }
        }
        self.coop_alive.insert(client_id.to_string(), false);
        self.coop_snakes
            .insert(client_id.to_string(), corpse.clone());
        if let Some(state) = self.native_relay.as_mut() {
            state.poses.insert(client_id.to_string(), corpse.clone());
        }
        self.push_broadcast(Envelope::new("COOP_PLAYER_DEAD", corpse));

        let needs_handoff = self
            .native_relay
            .as_ref()
            .map(|s| !s.board_ready && s.initializer_id.as_deref() == Some(client_id))
            .unwrap_or(false);
        if needs_handoff {
            let next = self.next_native_initializer();
            if let Some(state) = self.native_relay.as_mut() {
                state.initializer_id = next.clone();
            }
            self.collectables_owner = next;
            self.send_board_init_request();
        }
        self.maybe_end_coop_all_dead();
        Ok(())
    }

    fn mark_server_sim_seat_dead(&mut self, client_id: &str, reason: &str) {
        if self.current_coop_authority() != CoopAuthority::ServerSim
            || !self.coop_slots.iter().any(|id| id == client_id)
            || !self.coop_alive.get(client_id).copied().unwrap_or(false)
        {
            return;
        }
        self.coop_alive.insert(client_id.to_string(), false);
        let mut body = Value::Null;
        if let Some(game) = self.coop.as_mut() {
            if let Some(snake) = game
                .snakes
                .iter_mut()
                .find(|snake| snake.client_id == client_id)
            {
                snake.alive = false;
                body = json!(snake.body);
            }
        }
        self.coop_snakes.insert(
            client_id.to_string(),
            json!({"clientId": client_id, "body": body, "alive": false}),
        );
        self.push_broadcast(Envelope::new(
            "COOP_PLAYER_DEAD",
            json!({"clientId": client_id, "body": body, "reason": reason}),
        ));
        if let Some(game) = self.coop.as_ref() {
            self.push_broadcast(Envelope::new("COOP_STATE", game.snapshot()));
        }
        self.maybe_end_coop_all_dead();
    }

    fn maybe_end_coop_all_dead(&mut self) {
        if self.mode != Mode::Coop || !self.session_active {
            return;
        }
        let players = self.coop_slots.clone();
        if players.is_empty() {
            info!(roomId = %self.code, event = "coop_no_players");
            self.end_coop_session("ALL_DEAD");
            return;
        }
        let all_dead = players
            .iter()
            .all(|id| self.coop_alive.get(id).copied().unwrap_or(true) == false);
        if !all_dead {
            return;
        }
        if let Some(state) = self.native_relay.as_mut() {
            if state.ending {
                return;
            }
            state.ending = true;
        }
        info!(roomId = %self.code, event = "coop_all_dead");
        self.end_coop_session("ALL_DEAD");
    }

    fn cmd_score_pulse(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player || self.mode != Mode::Race {
            return Err("not_race_player".into());
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
        let alive = payload
            .get("alive")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        // Ignore forged Best-All claims after the attempt window ends
        let mut goal_all = payload
            .get("goalAll")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if self.attempt_expired {
            goal_all = false;
        }
        let goal = self.race_goal;
        {
            let entry = self
                .race_scores
                .entry(from.to_string())
                .or_insert(RaceScore {
                    score: 0,
                    time_ms: 0,
                    best_score: 0,
                    best_time_ms: None,
                    best_score_time_ms: None,
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
            // Track the fastest run time each best score was reached at, so a
            // match where nobody meets the goal still has a ranked winner.
            if score > entry.best_score {
                entry.best_score = score;
                entry.best_score_time_ms = if time_ms > 0 { Some(time_ms) } else { None };
            } else if score == entry.best_score && time_ms > 0 {
                match entry.best_score_time_ms {
                    None => entry.best_score_time_ms = Some(time_ms),
                    Some(best) if time_ms < best => entry.best_score_time_ms = Some(time_ms),
                    _ => {}
                }
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
        let sc = self.race_scores.get(from).cloned().unwrap_or(RaceScore {
            score,
            time_ms,
            best_score: score,
            best_time_ms: None,
            best_score_time_ms: None,
            best_goal_time_ms: None,
            goal_completed: false,
            alive,
            run_started_at_ms: None,
        });
        let leader_id = self.race_leader_id();
        let mut pulse = json!({
            "clientId": from,
            "score": score,
            "timeMs": time_ms,
            "alive": alive,
            "bestScore": sc.best_score,
            "bestTimeMs": sc.best_time_ms,
            "bestScoreTimeMs": sc.best_score_time_ms,
            "bestGoalTimeMs": sc.best_goal_time_ms,
            "goalCompleted": sc.goal_completed,
            "raceGoal": goal.as_str(),
            "leaderClientId": leader_id,
        });
        if let Some(started) = sc.run_started_at_ms {
            if let Some(obj) = pulse.as_object_mut() {
                obj.insert("runStartedAtMs".into(), json!(started));
            }
        }
        self.push_broadcast(Envelope::new("SCORE_PULSE", pulse));
        self.maybe_end_race_grace();
        Ok(())
    }

    /// Record timed-goal completion when score crosses the threshold or ALL clears.
    fn apply_goal_progress(
        goal: RaceGoal,
        entry: &mut RaceScore,
        score: u32,
        time_ms: u64,
        goal_all: bool,
    ) {
        if !goal.is_timed() {
            return;
        }
        let hit = match goal {
            RaceGoal::BestAll => goal_all,
            RaceGoal::Best25 | RaceGoal::Best50 | RaceGoal::Best100 => {
                goal.score_threshold().map(|n| score >= n).unwrap_or(false)
            }
            RaceGoal::Score => false,
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

    /// Highest score, fastest time to it on ties. Used when a timed goal was
    /// never met, so the match still has a winner.
    fn race_top_scorer_id(&self) -> Option<String> {
        let mut best_id: Option<String> = None;
        let mut best_s: Option<u32> = None;
        let mut best_t: Option<u64> = None;
        for (id, sc) in &self.race_scores {
            let s = sc.best_score;
            if s == 0 && sc.score == 0 {
                continue;
            }
            let t = sc.best_score_time_ms;
            let better = match best_s {
                None => true,
                Some(bs) if s > bs => true,
                Some(bs) if s == bs => match (t, best_t) {
                    (Some(t), Some(bt)) => t < bt,
                    (Some(_), None) => true,
                    _ => false,
                },
                _ => false,
            };
            if better {
                best_s = Some(s);
                best_t = t;
                best_id = Some(id.clone());
            }
        }
        best_id
    }

    /// Leader for the room race goal (Score = highest best; timed = fastest
    /// completion, falling back to top scorer when nobody met the goal).
    fn race_leader_id(&self) -> Option<String> {
        if self.mode != Mode::Race {
            return None;
        }
        let goal = self.race_goal;
        let mut best_id: Option<String> = None;
        if goal.is_timed() {
            let mut best_t: Option<u64> = None;
            for (id, sc) in &self.race_scores {
                let Some(t) = sc.best_goal_time_ms else {
                    continue;
                };
                if !sc.goal_completed {
                    continue;
                }
                if best_t.map(|b| t < b).unwrap_or(true) {
                    best_t = Some(t);
                    best_id = Some(id.clone());
                }
            }
            if best_id.is_none() {
                best_id = self.race_top_scorer_id();
            }
        } else {
            let mut best_s: Option<u32> = None;
            let mut best_t: Option<u64> = None;
            for (id, sc) in &self.race_scores {
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

    fn score_pulse_json(&self, pid: &str, sc: &RaceScore) -> Value {
        let mut pulse = json!({
            "clientId": pid,
            "score": sc.score,
            "timeMs": sc.time_ms,
            "alive": sc.alive,
            "bestScore": sc.best_score,
            "bestTimeMs": sc.best_time_ms,
            "bestScoreTimeMs": sc.best_score_time_ms,
            "bestGoalTimeMs": sc.best_goal_time_ms,
            "goalCompleted": sc.goal_completed,
            "raceGoal": self.race_goal.as_str(),
            "leaderClientId": self.race_leader_id(),
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
            self.push_to(
                from,
                Envelope::new("SESSION_START", self.native_metadata_payload(true)),
            );
            match self.current_coop_authority() {
                CoopAuthority::ServerSim => {
                    if let Some(ref game) = self.coop {
                        self.push_to(from, Envelope::new("COOP_STATE", game.snapshot()));
                    }
                    if let Some(ms) = self.coop_timer_started_at_ms {
                        self.push_to(
                            from,
                            Envelope::new(
                                "COOP_TIMER_START",
                                json!({
                                    "generation": self.coop_generation,
                                    "timerStartedAtMs": ms,
                                }),
                            ),
                        );
                    }
                }
                CoopAuthority::NativeRelay => {
                    let state = self.native_relay.clone().ok_or("not_native_relay")?;
                    // Canonical replay order: metadata, board, ready, poses,
                    // timer, speed, roster.
                    if let Some(board) = state.board_snapshot {
                        self.push_to(from, Envelope::new("COLLECTABLES_DELTA", board));
                        self.push_to(
                            from,
                            Envelope::new(
                                "COOP_BOARD_READY",
                                json!({
                                    "generation": self.coop_generation,
                                    "revision": state.board_revision,
                                    "collectablesOwnerId": self.collectables_owner,
                                    "modeKey": state.mode_key,
                                }),
                            ),
                        );
                    }
                    let mut poses: Vec<(usize, Value)> = state
                        .poses
                        .into_iter()
                        .filter_map(|(id, pose)| {
                            self.coop_slots
                                .iter()
                                .position(|slot| slot == &id)
                                .map(|index| (index, pose))
                        })
                        .collect();
                    poses.sort_by_key(|(index, _)| *index);
                    for (_, pose) in poses {
                        let message_type = if pose.get("alive") == Some(&json!(false)) {
                            "COOP_PLAYER_DEAD"
                        } else {
                            "SNAKE_DELTA"
                        };
                        self.push_to(from, Envelope::new(message_type, pose));
                    }
                    if let Some(ms) = self.coop_timer_started_at_ms {
                        self.push_to(
                            from,
                            Envelope::new(
                                "COOP_TIMER_START",
                                json!({
                                    "generation": self.coop_generation,
                                    "timerStartedAtMs": ms,
                                }),
                            ),
                        );
                    }
                    self.push_to(
                        from,
                        Envelope::new(
                            "COOP_SPEED_TRANSITION",
                            json!({
                                "generation": self.coop_generation,
                                "speedEpoch": state.speed_epoch,
                                "effectiveSpeed": state.effective_speed,
                                "resync": true,
                            }),
                        ),
                    );
                }
            }
        }
        if self.mode == Mode::Race {
            let is_spectator = self
                .clients
                .get(from)
                .map(|c| c.role == Role::Spectator)
                .unwrap_or(false);
            if is_spectator {
                let boards: Vec<(String, Value)> = self
                    .race_boards
                    .iter()
                    .map(|(pid, board)| (pid.clone(), board.clone()))
                    .collect();
                for (pid, board) in boards {
                    self.push_to(
                        from,
                        Envelope::new("BOARD_DELTA", json!({"clientId": pid, "board": board})),
                    );
                }
            }
            let scores: Vec<(String, RaceScore)> = self
                .race_scores
                .iter()
                .map(|(pid, sc)| (pid.clone(), sc.clone()))
                .collect();
            for (pid, sc) in scores {
                self.push_to(
                    from,
                    Envelope::new("SCORE_PULSE", self.score_pulse_json(&pid, &sc)),
                );
            }
            if !self.settings.is_null() {
                self.push_to(from, Envelope::new("SETTINGS_SYNC", self.settings.clone()));
            }
        }
        self.push_to(from, Envelope::new("ROSTER", self.roster_payload()));
        Ok(())
    }

    fn cmd_board(&mut self, from: &str, payload: &Value) -> Result<(), String> {
        let client = self.clients.get(from).ok_or("unknown_client")?;
        if client.role != Role::Player || self.mode != Mode::Race {
            return Err("not_race_player".into());
        }
        if !self.session_active {
            return Ok(());
        }
        if let Some(body) = payload.get("body").and_then(|v| v.as_array()) {
            if body.len() > 400 {
                return Err("board_too_large".into());
            }
        }
        self.race_boards.insert(from.to_string(), payload.clone());
        // Relay to spectators only
        let spectators: Vec<String> = self
            .clients
            .values()
            .filter(|c| c.role == Role::Spectator)
            .map(|c| c.client_id.clone())
            .collect();
        let env = Envelope::new("BOARD_DELTA", json!({"clientId": from, "board": payload}));
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
            if let Some(board) = self.race_boards.get(fid).cloned() {
                self.push_to(
                    from,
                    Envelope::new("BOARD_DELTA", json!({"clientId": fid, "board": board})),
                );
            }
        }
        Ok(())
    }

    /// Tick race attempt timer and co-op server sim.
    pub fn tick(&mut self) {
        if self.mode == Mode::Race {
            if let Some(deadline) = self.attempt_deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                emit_attempt_tick(self, remaining.as_millis() as u64);
                if Instant::now() >= deadline && !self.attempt_expired {
                    self.attempt_expired = true;
                    self.allow_new_runs = false;
                    let winner = self.race_leader_id();
                    if self.finish_ongoing_runs {
                        info!(roomId = %self.code, event = "attempt_expired_grace");
                        self.push_broadcast(Envelope::new(
                            "ATTEMPT_EXPIRED",
                            json!({
                                "winnerClientId": winner,
                                "raceGoal": self.race_goal.as_str(),
                                "raceGoalLabel": self.race_goal.label(),
                                "finishOngoing": true,
                            }),
                        ));
                        self.broadcast_roster();
                        self.maybe_end_race_grace();
                    } else {
                        self.session_active = false;
                        self.attempt_deadline = None;
                        info!(roomId = %self.code, event = "attempt_expired");
                        self.push_broadcast(Envelope::new(
                            "ATTEMPT_EXPIRED",
                            json!({
                                "winnerClientId": winner,
                                "raceGoal": self.race_goal.as_str(),
                                "raceGoalLabel": self.race_goal.label(),
                                "finishOngoing": false,
                            }),
                        ));
                        self.broadcast_roster();
                    }
                }
            }
        } else if self.mode == Mode::Coop
            && self.session_active
            && self.current_coop_authority() == CoopAuthority::ServerSim
        {
            self.tick_coop_sim();
        }
    }

    fn tick_coop_sim(&mut self) {
        let interval = self.coop.as_ref().map(|g| g.interval_ms()).unwrap_or(142);

        // Idle until first COOP_INPUT (same latch as shared timer). Auto-crawling
        // from SESSION_START killed snakes while clients were still clicking Play.
        if self.coop_timer_started_at_ms.is_none() {
            self.coop_accum_ms = 0;
            // Still tear down if the sim was marked ended without ever starting
            if let Some(ref game) = self.coop {
                if game.ended {
                    let reason = game.end_reason.clone().unwrap_or_else(|| "ENDED".into());
                    let snap = game.snapshot();
                    self.push_broadcast(Envelope::new("COOP_STATE", snap));
                    self.end_coop_session(&reason);
                }
            }
            return;
        }

        // Main loop calls tick every ~100ms
        self.coop_accum_ms = self.coop_accum_ms.saturating_add(100);
        let mut stepped = false;
        while self.coop_accum_ms >= interval {
            self.coop_accum_ms -= interval;

            // Resolve end outside the mutable game borrow so we can tear down fully.
            let mut end_reason: Option<String> = None;
            let mut final_snap: Option<Value> = None;

            if let Some(ref mut game) = self.coop {
                // Only `ended` finishes the room. `!running` alone used to mean
                // "waiting / stopped" and falsely SESSION_ENDed idle sims.
                if game.ended {
                    end_reason = Some(game.end_reason.clone().unwrap_or_else(|| "ENDED".into()));
                    final_snap = Some(game.snapshot());
                } else if game.running {
                    game.step();
                    stepped = true;
                    for s in &game.snakes {
                        self.coop_alive.insert(s.client_id.clone(), s.alive);
                    }
                    if game.ended {
                        end_reason =
                            Some(game.end_reason.clone().unwrap_or_else(|| "ENDED".into()));
                        final_snap = Some(game.snapshot());
                    }
                } else {
                    // Not running and not ended — wait (should be rare after timer arm)
                    break;
                }
            } else {
                break;
            }

            if let Some(reason) = end_reason {
                if let Some(snap) = final_snap {
                    self.push_broadcast(Envelope::new("COOP_STATE", snap));
                }
                self.end_coop_session(&reason);
                return;
            }
        }
        if stepped {
            if let Some(ref game) = self.coop {
                self.push_broadcast(Envelope::new("COOP_STATE", game.snapshot()));
            }
        }
    }

    /// After the clock expires with finish-ongoing, close the match once nobody
    /// is still alive in a run.
    fn maybe_end_race_grace(&mut self) {
        if self.mode != Mode::Race
            || !self.attempt_expired
            || !self.finish_ongoing_runs
            || !self.session_active
        {
            return;
        }
        let players: Vec<String> = self
            .players()
            .into_iter()
            .map(|p| p.client_id.clone())
            .collect();
        if players.is_empty() {
            self.finish_race_grace();
            return;
        }
        let any_alive = players.iter().any(|id| {
            self.race_scores.get(id).map(|s| s.alive).unwrap_or(true) // no pulse yet → still considered running
        });
        if !any_alive {
            self.finish_race_grace();
        }
    }

    fn finish_race_grace(&mut self) {
        if !self.session_active {
            return;
        }
        self.session_active = false;
        self.attempt_deadline = None;
        let winner = self.race_leader_id();
        info!(roomId = %self.code, event = "attempt_grace_complete");
        self.push_broadcast(Envelope::new(
            "ATTEMPT_EXPIRED",
            json!({
                "winnerClientId": winner,
                "raceGoal": self.race_goal.as_str(),
                "raceGoalLabel": self.race_goal.label(),
                "finishOngoing": false,
                "runsComplete": true,
            }),
        ));
        self.broadcast_roster();
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

pub fn sanitize_client_display_name(raw: Option<String>) -> Option<String> {
    const MAX_CHARS: usize = 32;
    let s = raw?;
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

pub fn resolve_display_name(client: &ClientState, all: &HashMap<String, ClientState>) -> String {
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
                && o.display_name
                    .as_ref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true)
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
    fn set_display_name_updates_roster() {
        let mut r = room();
        r.join("a".into(), Some("Old".into()), None).unwrap();
        r.cmd_set_display_name("a", &json!({"displayName": "New Name"}))
            .unwrap();
        assert_eq!(
            r.clients.get("a").unwrap().display_name.as_deref(),
            Some("New Name")
        );
        r.cmd_set_display_name("a", &json!({"displayName": "   "}))
            .unwrap();
        assert!(r.clients.get("a").unwrap().display_name.is_none());
        r.cmd_set_display_name(
            "a",
            &json!({"displayName": format!("{}{}", "Z".repeat(40), "\u{0007}")}),
        )
        .unwrap();
        let n = r.clients.get("a").unwrap().display_name.as_ref().unwrap();
        assert_eq!(n.len(), 32);
        assert!(!n.contains('\u{0007}'));
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
        assert_eq!(r.clients["s1"].spectate_focus.as_deref(), Some("p1"));
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
        assert_eq!(
            r.join("overflow".into(), None, None).unwrap_err(),
            "room_full"
        );
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
        assert!(r
            .cmd_session_start("a", &json!({}))
            .unwrap_err()
            .contains("not_all_ready"));
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
        assert_eq!(r.cmd_session_end("b", &json!({})).unwrap_err(), "not_admin");
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
        let env =
            parse_envelope(r#"{"v":1,"type":"MODE_CHANGE","payload":{"mode":"coop"}}"#).unwrap();
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
    fn race_scores_survive_expire_and_abort_until_next_start() {
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
        r.cmd_score_pulse("a", &json!({"score": 9, "timeMs": 1000, "alive": false}))
            .unwrap();
        r.cmd_score_pulse("b", &json!({"score": 3, "timeMs": 500, "alive": false}))
            .unwrap();
        assert_eq!(r.race_scores.len(), 2);

        // Timer expiry keeps scores and ends the live session
        r.attempt_expired = true;
        r.allow_new_runs = false;
        r.session_active = false;
        assert_eq!(r.race_scores["a"].best_score, 9);
        assert!(!r.session_active);

        // End match keeps scores for display; marks attempt_expired
        r.cmd_session_end("a", &json!({})).unwrap();
        assert!(!r.session_active);
        assert!(r.attempt_expired);
        assert_eq!(r.race_scores.len(), 2);
        assert_eq!(r.race_scores["a"].best_score, 9);

        // Next Start match clears prior results
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("b", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        assert!(r.race_scores.is_empty());
        assert!(!r.attempt_expired);
        assert!(r.allow_new_runs);
    }

    #[test]
    fn timed_goal_falls_back_to_top_score_then_fastest_time() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.join("c".into(), None, None).unwrap();
        for id in ["a", "b", "c"] {
            r.cmd_set_role("a", &json!({"clientId": id, "role": "player"}))
                .unwrap();
            r.cmd_ready(id, &json!({"ready": true})).unwrap();
        }
        r.cmd_set_race_goal("a", &json!({"goal": "best25"}))
            .unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();

        // Nobody reaches 25 apples
        r.cmd_score_pulse("a", &json!({"score": 12, "timeMs": 9000, "alive": false}))
            .unwrap();
        r.cmd_score_pulse("b", &json!({"score": 18, "timeMs": 8000, "alive": false}))
            .unwrap();
        r.cmd_score_pulse("c", &json!({"score": 18, "timeMs": 5000, "alive": false}))
            .unwrap();

        assert_eq!(r.race_scores["c"].best_score, 18);
        assert_eq!(r.race_scores["c"].best_score_time_ms, Some(5000));
        // 18 beats 12; c reached 18 faster than b
        assert_eq!(r.race_leader_id().as_deref(), Some("c"));

        // A later run to the same score in less time keeps the faster stamp
        r.cmd_score_pulse("b", &json!({"score": 18, "timeMs": 4000, "alive": false}))
            .unwrap();
        assert_eq!(r.race_scores["b"].best_score_time_ms, Some(4000));
        assert_eq!(r.race_leader_id().as_deref(), Some("b"));

        // An actual goal completion outranks any unfinished score
        r.cmd_score_pulse("a", &json!({"score": 25, "timeMs": 20000, "alive": true}))
            .unwrap();
        assert!(r.race_scores["a"].goal_completed);
        assert_eq!(r.race_leader_id().as_deref(), Some("a"));
    }

    #[test]
    fn attempt_expire_hard_stop_clears_session_active() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_set_duration("a", &json!({"minutes": 1})).unwrap();
        r.cmd_session_start("a", &json!({"finishOngoingRuns": false}))
            .unwrap();
        assert!(r.session_active);
        assert!(!r.finish_ongoing_runs);
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
    fn attempt_expire_finish_ongoing_waits_for_deaths() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.join("b".into(), None, None).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_set_role("a", &json!({"clientId": "b", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("b", &json!({"ready": true})).unwrap();
        r.cmd_set_duration("a", &json!({"minutes": 1})).unwrap();
        r.cmd_session_start("a", &json!({"finishOngoingRuns": true}))
            .unwrap();
        assert!(r.finish_ongoing_runs);
        r.cmd_score_pulse("a", &json!({"score": 5, "timeMs": 1000, "alive": true}))
            .unwrap();
        r.cmd_score_pulse("b", &json!({"score": 2, "timeMs": 800, "alive": true}))
            .unwrap();
        r.take_outbox();
        r.attempt_deadline = Some(std::time::Instant::now() - std::time::Duration::from_secs(1));
        r.tick();
        assert!(r.attempt_expired);
        assert!(!r.allow_new_runs);
        assert!(r.session_active, "grace keeps session live");
        let out = r.take_outbox();
        let expired = out
            .iter()
            .find(|(_, e)| e.msg_type == "ATTEMPT_EXPIRED")
            .expect("ATTEMPT_EXPIRED");
        assert_eq!(expired.1.payload["finishOngoing"], json!(true));

        // One death — still grace
        r.cmd_score_pulse("a", &json!({"score": 5, "timeMs": 1200, "alive": false}))
            .unwrap();
        assert!(r.session_active);

        // Last death ends the match
        r.cmd_score_pulse("b", &json!({"score": 2, "timeMs": 900, "alive": false}))
            .unwrap();
        assert!(!r.session_active);
        let out2 = r.take_outbox();
        assert!(out2.iter().any(|(_, e)| {
            e.msg_type == "ATTEMPT_EXPIRED" && e.payload["runsComplete"] == json!(true)
        }));
    }

    #[test]
    fn coop_input_arms_timer_and_state_ticks() {
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
        assert!(r.coop.is_some());
        r.cmd_input("a", &json!({"dir": "UP"})).unwrap();
        let out = r.take_outbox();
        assert!(out.iter().any(|(_, e)| e.msg_type == "COOP_TIMER_START"));
        assert!(r.coop_timer_started_at_ms.is_some());
        // Force a sim step
        r.coop_accum_ms = 10_000;
        r.tick();
        let out2 = r.take_outbox();
        assert!(
            out2.iter().any(|(_, e)| e.msg_type == "COOP_STATE"),
            "tick must broadcast COOP_STATE"
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
    fn resync_pushes_race_boards_to_spectator() {
        let mut r = room();
        r.join("admin".into(), None, None).unwrap();
        r.join("player".into(), None, None).unwrap();
        r.join("spec".into(), None, None).unwrap();
        r.cmd_set_role("admin", &json!({"clientId": "player", "role": "player"}))
            .unwrap();
        r.race_boards.insert(
            "player".into(),
            json!({"score": 3, "body": [{"x":1,"y":1}]}),
        );
        r.take_outbox();
        r.cmd_resync("spec").unwrap();
        let out = r.take_outbox();
        assert!(out
            .iter()
            .any(|(to, e)| { to.as_deref() == Some("spec") && e.msg_type == "BOARD_DELTA" }));
        assert!(out
            .iter()
            .any(|(to, e)| { to.as_deref() == Some("spec") && e.msg_type == "ROSTER" }));
    }

    #[test]
    fn resync_coop_pushes_timer_and_slots() {
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
        r.cmd_input("a", &json!({"dir": "UP"})).unwrap();
        r.take_outbox();
        assert!(r.coop_timer_started_at_ms.is_some());
        r.cmd_resync("b").unwrap();
        let out = r.take_outbox();
        let timer = out
            .iter()
            .find(|(to, e)| to.as_deref() == Some("b") && e.msg_type == "COOP_TIMER_START");
        assert!(timer.is_some(), "resync must replay COOP_TIMER_START");
        assert_eq!(
            timer.unwrap().1.payload["timerStartedAtMs"],
            r.coop_timer_started_at_ms.unwrap()
        );
        let seats = out.iter().find(|(to, e)| {
            to.as_deref() == Some("b")
                && e.msg_type == "SESSION_START"
                && e.payload.get("resync") == Some(&json!(true))
        });
        assert!(seats.is_some(), "resync must replay coop slots");
        let slots = seats.unwrap().1.payload["slots"].as_array().unwrap();
        assert_eq!(slots.len(), 2);
        assert!(slots
            .iter()
            .any(|s| s["clientId"] == "b" && s["oy"].is_number()));
        assert!(
            out.iter()
                .any(|(to, e)| { to.as_deref() == Some("b") && e.msg_type == "COOP_STATE" }),
            "resync should push live COOP_STATE when present"
        );
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
    fn coop_sim_idle_until_first_input() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.cmd_mode_change("a", &json!({"mode": "coop"})).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        r.take_outbox();
        let tick0 = r.coop.as_ref().map(|g| g.tick).unwrap_or(0);
        // Many room ticks with no input must not crawl / end the run
        for _ in 0..30 {
            r.coop_accum_ms = 10_000;
            r.tick();
        }
        assert!(r.session_active, "idle session must stay active");
        assert_eq!(
            r.coop.as_ref().map(|g| g.tick).unwrap_or(0),
            tick0,
            "sim must not step before first input"
        );
        assert!(r.coop_timer_started_at_ms.is_none());
        let out = r.take_outbox();
        assert!(
            !out.iter().any(|(_, e)| e.msg_type == "SESSION_END"),
            "idle must not SESSION_END"
        );
    }

    #[test]
    fn coop_one_input_does_not_crawl_peer() {
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
        let b0 = r
            .coop
            .as_ref()
            .and_then(|g| g.snakes.iter().find(|s| s.client_id == "b"))
            .map(|s| s.body.clone())
            .expect("peer body");
        r.cmd_input("a", &json!({"dir": "RIGHT"})).unwrap();
        for _ in 0..5 {
            r.coop_accum_ms = 10_000;
            r.tick();
        }
        let b1 = r
            .coop
            .as_ref()
            .and_then(|g| g.snakes.iter().find(|s| s.client_id == "b"))
            .map(|s| s.body.clone())
            .expect("peer body");
        assert_eq!(b0, b1, "peer must stay parked until they press a key");
        let a_moved = r
            .coop
            .as_ref()
            .and_then(|g| g.snakes.iter().find(|s| s.client_id == "a"))
            .map(|s| s.body[0].x != s.body[1].x)
            .unwrap_or(false);
        assert!(a_moved, "sender should have crawled");
    }

    #[test]
    fn coop_session_emits_state_and_sim_ends_all_dead() {
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
        let out = r.take_outbox();
        assert!(out.iter().any(|(_, e)| e.msg_type == "COOP_STATE"));
        assert!(r.coop.is_some());
        // Drive both snakes into the left wall via server inputs
        for _ in 0..40 {
            r.cmd_input("a", &json!({"dir": "LEFT"})).ok();
            r.cmd_input("b", &json!({"dir": "LEFT"})).ok();
            r.coop_accum_ms = 10_000;
            r.tick();
            if !r.session_active {
                break;
            }
        }
        let out = r.take_outbox();
        assert!(
            out.iter()
                .any(|(_, e)| { e.msg_type == "SESSION_END" && e.payload["reason"] == "ALL_DEAD" }),
            "server sim should end ALL_DEAD"
        );
        assert!(!r.session_active);
        // Lobby must not look mid-run after sim end
        assert!(r.coop.is_none());
        assert!(r.coop_timer_started_at_ms.is_none());
        assert!(r.coop_slots.is_empty());
        assert!(r.coop_alive.is_empty());
        assert!(r.coop_seated.is_empty());
        assert_eq!(r.coop_accum_ms, 0);
        assert!(r.clients.values().all(|c| !c.ready));
    }

    #[test]
    fn coop_stuck_ended_sim_still_session_ends() {
        let mut r = room();
        r.join("a".into(), None, None).unwrap();
        r.cmd_mode_change("a", &json!({"mode": "coop"})).unwrap();
        r.cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        r.take_outbox();
        r.cmd_input("a", &json!({"dir": "UP"})).unwrap();
        r.take_outbox();
        assert!(r.coop_timer_started_at_ms.is_some());
        // Simulate the old bug: sim already ended but session still active
        if let Some(ref mut g) = r.coop {
            g.ended = true;
            g.running = false;
            g.end_reason = Some("ALL_APPLES".into());
        }
        r.coop_accum_ms = 10_000;
        r.tick();
        let out = r.take_outbox();
        assert!(
            out.iter().any(|(_, e)| {
                e.msg_type == "SESSION_END" && e.payload["reason"] == "ALL_APPLES"
            }),
            "stuck ended sim must still SESSION_END"
        );
        assert!(!r.session_active);
        assert!(r.coop.is_none());
        assert!(r.coop_timer_started_at_ms.is_none());
    }

    #[test]
    fn coop_player_numbers_deterministic_and_in_roster() {
        let mut r = room();
        r.join("z".into(), None, None).unwrap();
        r.join("a".into(), None, None).unwrap();
        r.join("m".into(), None, None).unwrap();
        r.cmd_mode_change("z", &json!({"mode": "coop"})).unwrap();
        // Promote in non-join order so promote_order differs from join_order
        r.cmd_set_role("z", &json!({"clientId": "m", "role": "player"}))
            .unwrap();
        r.cmd_set_role("z", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        r.cmd_set_role("z", &json!({"clientId": "z", "role": "player"}))
            .unwrap();
        r.take_outbox();
        // Idle roster: seats by promote then join
        r.broadcast_roster();
        let out = r.take_outbox();
        let roster = out
            .iter()
            .rev()
            .find(|(_, e)| e.msg_type == "ROSTER")
            .expect("ROSTER");
        let clients = roster.1.payload["clients"].as_array().unwrap();
        let mut by_id = std::collections::HashMap::new();
        for c in clients {
            by_id.insert(c["clientId"].as_str().unwrap().to_string(), c.clone());
        }
        assert_eq!(by_id["m"]["playerNumber"], 1);
        assert_eq!(by_id["a"]["playerNumber"], 2);
        assert_eq!(by_id["z"]["playerNumber"], 3);
        assert_eq!(by_id["m"]["coopSlot"], 0);
        assert_eq!(by_id["a"]["coopSlot"], 1);
        assert_eq!(by_id["z"]["coopSlot"], 2);

        r.cmd_ready("m", &json!({"ready": true})).unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_ready("z", &json!({"ready": true})).unwrap();
        r.take_outbox();
        r.cmd_session_start("z", &json!({})).unwrap();
        let out = r.take_outbox();
        let start = out
            .iter()
            .find(|(_, e)| e.msg_type == "SESSION_START")
            .expect("SESSION_START");
        let slots = start.1.payload["slots"].as_array().unwrap();
        assert_eq!(slots[0]["clientId"], "m");
        assert_eq!(slots[0]["playerNumber"], 1);
        assert_eq!(slots[0]["x"], 8);
        assert_eq!(slots[0]["y"], 7);
        assert_eq!(slots[0]["dir"], "RIGHT");
        assert_eq!(slots[1]["clientId"], "a");
        assert_eq!(slots[2]["clientId"], "z");
        assert_eq!(
            r.coop_slots,
            vec!["m".to_string(), "a".to_string(), "z".to_string()]
        );
    }

    #[test]
    fn coop_disconnect_marks_dead_keeps_session_for_survivor() {
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
        let seats_before = r.coop_slots.clone();
        r.leave("a");
        let out = r.take_outbox();
        assert!(out
            .iter()
            .any(|(_, e)| { e.msg_type == "COOP_PLAYER_DEAD" && e.payload["clientId"] == "a" }));
        assert!(out.iter().any(|(_, e)| e.msg_type == "COOP_STATE"));
        assert_eq!(r.coop_alive.get("a"), Some(&false));
        assert_eq!(r.coop_slots, seats_before);
        assert!(r.session_active);
        // Kill b via sim
        for _ in 0..40 {
            r.cmd_input("b", &json!({"dir": "LEFT"})).ok();
            r.coop_accum_ms = 10_000;
            r.tick();
            if !r.session_active {
                break;
            }
        }
        let out = r.take_outbox();
        assert!(out
            .iter()
            .any(|(_, e)| { e.msg_type == "SESSION_END" && e.payload["reason"] == "ALL_DEAD" }));
    }

    #[test]
    fn coop_three_players_sim_all_dead() {
        let mut r = room();
        for id in ["a", "b", "c"] {
            r.join(id.into(), None, None).unwrap();
        }
        r.cmd_mode_change("a", &json!({"mode": "coop"})).unwrap();
        for id in ["a", "b", "c"] {
            r.cmd_set_role("a", &json!({"clientId": id, "role": "player"}))
                .unwrap();
            r.cmd_ready(id, &json!({"ready": true})).unwrap();
        }
        r.take_outbox();
        r.cmd_session_start("a", &json!({})).unwrap();
        r.take_outbox();
        assert!(r.session_active);
        for _ in 0..50 {
            for id in ["a", "b", "c"] {
                r.cmd_input(id, &json!({"dir": "LEFT"})).ok();
            }
            r.coop_accum_ms = 10_000;
            r.tick();
            if !r.session_active {
                break;
            }
        }
        let out = r.take_outbox();
        assert!(out
            .iter()
            .any(|(_, e)| { e.msg_type == "SESSION_END" && e.payload["reason"] == "ALL_DEAD" }));
        assert!(!r.session_active);
    }

    fn native_room(ids: &[&str]) -> Room {
        let mut r = Room::new_with_coop_native_relay("TEST".into(), true);
        for id in ids {
            r.join((*id).into(), None, None).unwrap();
        }
        let admin = ids[0];
        r.cmd_mode_change(admin, &json!({"mode": "coop"})).unwrap();
        for id in ids {
            r.cmd_set_role(admin, &json!({"clientId": id, "role": "player"}))
                .unwrap();
            r.cmd_ready(id, &json!({"ready": true})).unwrap();
        }
        r.take_outbox();
        r.cmd_session_start(admin, &json!({"settings": {"size": 0, "speed": false}}))
            .unwrap();
        r
    }

    fn native_pose(generation: u64, event_seq: u64, pose_seq: u64, moved: bool) -> Value {
        json!({
            "generation": generation,
            "eventSeq": event_seq,
            "poseSeq": pose_seq,
            "seated": true,
            "moved": moved,
            "body": [{"x": 8, "y": 7}, {"x": 7, "y": 7}, {"x": 6, "y": 7}],
            "dir": "RIGHT",
            "moveSeq": pose_seq,
            "fromHead": {"x": 7, "y": 7},
            "toHead": {"x": 8, "y": 7},
            "movementDir": "RIGHT",
            "headDir": "RIGHT",
            "transitionDir": "RIGHT",
            "modeKey": "classic",
            "turns": [],
            "nativeTick": pose_seq,
            "stepIntervalMs": 142,
        })
    }

    fn native_turn(turn_seq: u64, move_seq: u64) -> Value {
        json!({
            "turnSeq": turn_seq,
            "at": {"x": 8, "y": 7},
            "fromDir": "UP",
            "toDir": "RIGHT",
            "moveSeq": move_seq,
        })
    }

    fn make_native_board_ready(r: &mut Room, owner: &str, pose_event: u64, board_event: u64) {
        make_native_board_ready_mode(r, owner, pose_event, board_event, "classic");
    }

    fn make_native_board_ready_mode(
        r: &mut Room,
        owner: &str,
        pose_event: u64,
        board_event: u64,
        mode_key: &str,
    ) {
        let generation = r.coop_generation;
        r.cmd_snake_delta(
            owner,
            &native_pose(generation, pose_event, pose_event, false),
        )
        .unwrap();
        r.cmd_collectables_delta(
            owner,
            &json!({
                "generation": generation,
                "eventSeq": board_event,
                "initial": true,
                "baseRevision": 0,
                "modeKey": mode_key,
                "collectables": [{"x": 3, "y": 4, "type": "apple"}],
            }),
        )
        .unwrap();
    }

    #[test]
    fn native_gate_freezes_authority_and_preserves_server_sim_default() {
        let mut normal = room();
        normal.join("a".into(), None, None).unwrap();
        normal
            .cmd_mode_change("a", &json!({"mode": "coop"}))
            .unwrap();
        normal
            .cmd_set_role("a", &json!({"clientId": "a", "role": "player"}))
            .unwrap();
        normal.cmd_ready("a", &json!({"ready": true})).unwrap();
        normal.cmd_session_start("a", &json!({})).unwrap();
        assert_eq!(normal.coop_authority, Some(CoopAuthority::ServerSim));
        assert!(normal.coop.is_some());

        let mut native = native_room(&["a"]);
        assert_eq!(native.coop_authority, Some(CoopAuthority::NativeRelay));
        assert!(native.coop.is_none());
        let out = native.take_outbox();
        let start = out
            .iter()
            .find(|(_, e)| e.msg_type == "SESSION_START")
            .expect("native SESSION_START");
        assert_eq!(start.1.payload["authority"], NATIVE_RELAY_AUTHORITY);
        assert_eq!(start.1.payload["serverAuth"], false);
        assert!(!out.iter().any(|(_, e)| e.msg_type == "COOP_STATE"));
        assert!(out.iter().any(|(_, e)| e.msg_type == "COOP_BOARD_INIT"));
        native.coop_native_relay_enabled = false;
        assert_eq!(
            native.coop_authority,
            Some(CoopAuthority::NativeRelay),
            "rollout changes cannot alter an active generation"
        );
    }

    #[test]
    fn native_board_handshake_sequences_and_timer_are_server_owned() {
        let mut r = native_room(&["a", "b"]);
        let generation = r.coop_generation;
        r.take_outbox();
        assert_eq!(
            r.cmd_collectables_delta(
                "b",
                &json!({
                    "generation": generation,
                    "eventSeq": 1,
                    "initial": true,
                    "baseRevision": 0,
                    "collectables": [],
                }),
            )
            .unwrap_err(),
            "not_board_initializer"
        );
        assert_eq!(
            r.cmd_snake_delta("a", &native_pose(generation, 1, 1, true))
                .unwrap_err(),
            "board_not_ready"
        );
        assert!(r.coop_timer_started_at_ms.is_none());
        make_native_board_ready(&mut r, "a", 1, 2);
        let board_out = r.take_outbox();
        assert!(board_out
            .iter()
            .any(|(_, e)| e.msg_type == "COOP_BOARD_READY"));
        assert_eq!(r.native_relay.as_ref().unwrap().board_revision, 1);
        assert_eq!(
            r.cmd_collectables_delta(
                "a",
                &json!({
                    "generation": generation,
                    "eventSeq": 3,
                    "initial": false,
                    "baseRevision": 1,
                    "collectables": [],
                }),
            )
            .unwrap_err(),
            "runtime_board_updates_disabled"
        );
        r.cmd_snake_delta("b", &native_pose(generation, 1, 1, true))
            .unwrap();
        let timer_out = r.take_outbox();
        assert_eq!(
            timer_out
                .iter()
                .filter(|(_, e)| e.msg_type == "COOP_TIMER_START")
                .count(),
            1
        );
        r.cmd_snake_delta("b", &native_pose(generation, 2, 2, true))
            .unwrap();
        assert!(!r
            .take_outbox()
            .iter()
            .any(|(_, e)| e.msg_type == "COOP_TIMER_START"));
        assert_eq!(
            r.cmd_snake_delta("b", &native_pose(generation, 2, 3, true))
                .unwrap_err(),
            "stale_event_seq"
        );
        assert_eq!(
            r.cmd_snake_delta("b", &native_pose(generation, 3, 2, true))
                .unwrap_err(),
            "stale_pose_seq"
        );
    }

    #[test]
    fn native_disconnect_hands_off_initializer_and_all_dead_is_once() {
        let mut r = native_room(&["a", "b"]);
        let frozen = r.coop_slots.clone();
        r.take_outbox();
        r.leave("a");
        assert_eq!(r.coop_slots, frozen);
        assert_eq!(
            r.native_relay
                .as_ref()
                .and_then(|s| s.initializer_id.as_deref()),
            Some("b")
        );
        let handoff = r.take_outbox();
        assert!(handoff.iter().any(|(_, e)| {
            e.msg_type == "COOP_PLAYER_DEAD" && e.payload["reason"] == "disconnect"
        }));
        assert!(handoff.iter().any(|(_, e)| {
            e.msg_type == "COOP_BOARD_INIT" && e.payload["initializerClientId"] == "b"
        }));
        make_native_board_ready(&mut r, "b", 1, 2);
        r.take_outbox();
        r.cmd_coop_player_dead(
            "b",
            &json!({
                "generation": r.coop_generation,
                "eventSeq": 3,
                "body": [{"x": 8, "y": 7}],
                "reason": "wall",
            }),
        )
        .unwrap();
        let terminal = r.take_outbox();
        assert_eq!(
            terminal
                .iter()
                .filter(|(_, e)| {
                    e.msg_type == "SESSION_END" && e.payload["reason"] == "ALL_DEAD"
                })
                .count(),
            1
        );
        assert!(!r.session_active);
    }

    #[test]
    fn native_run_settings_resync_and_speed_are_canonical() {
        let mut r = native_room(&["a", "b"]);
        let generation = r.coop_generation;
        make_native_board_ready(&mut r, "a", 1, 2);
        r.cmd_snake_delta("b", &native_pose(generation, 1, 1, true))
            .unwrap();
        r.cmd_settings_sync("a", &json!({"size": 2, "speed": true}))
            .unwrap();
        assert_eq!(
            r.coop_run_settings.as_ref().unwrap()["size"],
            0,
            "live settings must remain frozen"
        );
        r.cmd_coop_speed_transition(
            "a",
            &json!({
                "generation": generation,
                "eventSeq": 3,
                "sourceEventId": "toggle-1",
                "transition": {"type": "toggle"},
            }),
        )
        .unwrap();
        r.cmd_coop_speed_transition(
            "a",
            &json!({
                "generation": generation,
                "eventSeq": 4,
                "sourceEventId": "toggle-2",
                "transition": {"type": "toggle"},
            }),
        )
        .unwrap();
        let state = r.native_relay.as_ref().unwrap();
        assert_eq!(state.speed_epoch, 2);
        assert_eq!(state.effective_speed, false);
        r.take_outbox();
        r.cmd_resync("b").unwrap();
        let out = r.take_outbox();
        let types: Vec<&str> = out.iter().map(|(_, e)| e.msg_type.as_str()).collect();
        let metadata = types.iter().position(|t| *t == "SESSION_START").unwrap();
        let board = types
            .iter()
            .position(|t| *t == "COLLECTABLES_DELTA")
            .unwrap();
        let ready = types.iter().position(|t| *t == "COOP_BOARD_READY").unwrap();
        let pose = types.iter().position(|t| *t == "SNAKE_DELTA").unwrap();
        let timer = types.iter().position(|t| *t == "COOP_TIMER_START").unwrap();
        let speed = types
            .iter()
            .position(|t| *t == "COOP_SPEED_TRANSITION")
            .unwrap();
        let roster = types.iter().position(|t| *t == "ROSTER").unwrap();
        assert!(metadata < board && board < ready && ready < pose);
        assert!(pose < timer && timer < speed && speed < roster);
        assert_eq!(out[metadata].1.payload["generation"], generation);
        assert_eq!(out[speed].1.payload["speedEpoch"], 2);
    }

    #[test]
    fn native_generation_rejects_stale_packets_and_clears_state() {
        let mut r = native_room(&["a"]);
        let first = r.coop_generation;
        make_native_board_ready(&mut r, "a", 1, 2);
        r.cmd_session_end("a", &json!({})).unwrap();
        r.cmd_ready("a", &json!({"ready": true})).unwrap();
        r.cmd_session_start("a", &json!({})).unwrap();
        assert_eq!(r.coop_generation, first + 1);
        let state = r.native_relay.as_ref().unwrap();
        assert_eq!(state.board_revision, 0);
        assert!(state.poses.is_empty());
        assert!(r.coop_timer_started_at_ms.is_none());
        assert_eq!(
            r.cmd_snake_delta("a", &native_pose(first, 10, 10, false))
                .unwrap_err(),
            "stale_generation"
        );
    }

    #[test]
    fn native_plan2_rejects_mode_direction_and_cell_mismatches() {
        let mut r = native_room(&["a"]);
        let generation = r.coop_generation;
        r.cmd_snake_delta("a", &native_pose(generation, 1, 1, false))
            .unwrap();
        let board = json!({
            "generation": generation,
            "eventSeq": 2,
            "initial": true,
            "baseRevision": 0,
            "collectables": [],
        });
        assert_eq!(
            r.cmd_collectables_delta("a", &board).unwrap_err(),
            "missing_mode_key"
        );
        let mut oversized_mode = board.clone();
        oversized_mode["modeKey"] = json!("x".repeat(MAX_NATIVE_MODE_KEY_LEN + 1));
        assert_eq!(
            r.cmd_collectables_delta("a", &oversized_mode).unwrap_err(),
            "bad_mode_key"
        );
        let mut canonical = board;
        canonical["modeKey"] = json!("CLASSIC");
        r.cmd_collectables_delta("a", &canonical).unwrap();
        assert_eq!(
            r.native_relay.as_ref().unwrap().mode_key.as_deref(),
            Some("classic")
        );

        let mut pose = native_pose(generation, 3, 2, true);
        pose["modeKey"] = json!("yin_yang");
        assert_eq!(
            r.cmd_snake_delta("a", &pose).unwrap_err(),
            "mode_key_mismatch"
        );

        pose["modeKey"] = json!("classic");
        pose["movementDir"] = json!("diagonal");
        assert_eq!(
            r.cmd_snake_delta("a", &pose).unwrap_err(),
            "bad_movementDir"
        );

        pose["movementDir"] = json!("right");
        pose["transitionDir"] = json!("NONE");
        pose["fromHead"] = json!({"x": -1, "y": 7});
        assert_eq!(r.cmd_snake_delta("a", &pose).unwrap_err(), "bad_fromHead");

        pose["fromHead"] = json!({"x": 7, "y": 7});
        pose["turns"] = json!([{
            "turnSeq": 1,
            "at": {"x": 17, "y": 7},
            "fromDir": "UP",
            "toDir": "RIGHT",
            "moveSeq": 2,
        }]);
        assert_eq!(r.cmd_snake_delta("a", &pose).unwrap_err(), "bad_turn_cell");
    }

    #[test]
    fn native_plan2_validates_turn_overlap_suffix_regression_and_limit() {
        let mut r = native_room(&["a"]);
        let generation = r.coop_generation;
        make_native_board_ready(&mut r, "a", 1, 2);

        let mut first = native_pose(generation, 3, 2, true);
        first["moveSeq"] = json!(2);
        first["turns"] = json!([native_turn(1, 2)]);
        r.cmd_snake_delta("a", &first).unwrap();

        let mut overlap = native_pose(generation, 4, 3, true);
        overlap["moveSeq"] = json!(3);
        overlap["turns"] = json!([native_turn(1, 2), native_turn(2, 3)]);
        r.cmd_snake_delta("a", &overlap).unwrap();

        let mut tampered = native_pose(generation, 5, 4, true);
        tampered["moveSeq"] = json!(4);
        tampered["turns"] = json!([
            {
                "turnSeq": 2,
                "at": {"x": 8, "y": 7},
                "fromDir": "LEFT",
                "toDir": "RIGHT",
                "moveSeq": 3,
            },
            native_turn(3, 4)
        ]);
        assert_eq!(
            r.cmd_snake_delta("a", &tampered).unwrap_err(),
            "turn_overlap_mismatch"
        );

        let mut gap = native_pose(generation, 5, 4, true);
        gap["moveSeq"] = json!(4);
        gap["turns"] = json!([native_turn(4, 4)]);
        assert_eq!(
            r.cmd_snake_delta("a", &gap).unwrap_err(),
            "turn_suffix_not_contiguous"
        );

        let mut regression = native_pose(generation, 5, 4, true);
        regression["moveSeq"] = json!(4);
        regression["turns"] = json!([native_turn(1, 2)]);
        assert_eq!(
            r.cmd_snake_delta("a", &regression).unwrap_err(),
            "turn_seq_regression"
        );

        let mut too_many = native_pose(generation, 5, 4, true);
        too_many["moveSeq"] = json!(4);
        too_many["turns"] =
            Value::Array((1..=9).map(|seq| native_turn(seq, seq)).collect::<Vec<_>>());
        assert_eq!(
            r.cmd_snake_delta("a", &too_many).unwrap_err(),
            "too_many_turns"
        );
    }

    #[test]
    fn native_plan2_rejects_move_regression_and_oversized_visuals() {
        let mut r = native_room(&["a"]);
        let generation = r.coop_generation;
        make_native_board_ready(&mut r, "a", 1, 2);

        let mut accepted = native_pose(generation, 3, 2, true);
        accepted["moveSeq"] = json!(5);
        r.cmd_snake_delta("a", &accepted).unwrap();

        let mut regressed = native_pose(generation, 4, 3, true);
        regressed["moveSeq"] = json!(4);
        assert_eq!(
            r.cmd_snake_delta("a", &regressed).unwrap_err(),
            "move_seq_regression"
        );

        let mut oversized = native_pose(generation, 4, 3, true);
        oversized["moveSeq"] = json!(5);
        oversized["companionStyle"] = json!("x".repeat(MAX_NATIVE_VISUAL_STRING_LEN + 1));
        assert_eq!(
            r.cmd_snake_delta("a", &oversized).unwrap_err(),
            "visual_string_too_long"
        );
    }

    #[test]
    fn native_plan2_enforces_yin_yang_companion_contract() {
        let mut yy = native_room(&["a"]);
        let generation = yy.coop_generation;
        make_native_board_ready_mode(&mut yy, "a", 1, 2, "yin_yang");
        yy.take_outbox();

        let mut missing = native_pose(generation, 3, 2, true);
        missing["modeKey"] = json!("yin_yang");
        assert_eq!(
            yy.cmd_snake_delta("a", &missing).unwrap_err(),
            "yin_yang_body2_required"
        );

        let mut incomplete = native_pose(generation, 3, 2, true);
        incomplete["modeKey"] = json!("yin_yang");
        incomplete["body2"] = json!([{"x": 9, "y": 7}, {"x": 10, "y": 7}]);
        assert_eq!(
            yy.cmd_snake_delta("a", &incomplete).unwrap_err(),
            "missing_movementDir2"
        );

        incomplete["movementDir2"] = json!("LEFT");
        incomplete["headDir2"] = json!("LEFT");
        incomplete["transitionDir2"] = Value::Null;
        yy.cmd_snake_delta("a", &incomplete).unwrap();
        let echoed = yy
            .take_outbox()
            .into_iter()
            .find(|(_, envelope)| envelope.msg_type == "SNAKE_DELTA")
            .unwrap()
            .1;
        assert_eq!(echoed.payload["transitionDir2"], "NONE");

        let mut classic = native_room(&["a"]);
        let generation = classic.coop_generation;
        make_native_board_ready(&mut classic, "a", 1, 2);
        let mut body2 = native_pose(generation, 3, 2, true);
        body2["body2"] = json!([{"x": 9, "y": 7}]);
        body2["movementDir2"] = json!("LEFT");
        body2["headDir2"] = json!("LEFT");
        body2["transitionDir2"] = json!("LEFT");
        assert_eq!(
            classic.cmd_snake_delta("a", &body2).unwrap_err(),
            "body2_not_allowed"
        );
    }

    #[test]
    fn native_plan2_resync_retains_canonical_mode_and_turn_baselines() {
        let mut r = native_room(&["a", "b"]);
        let generation = r.coop_generation;
        make_native_board_ready(&mut r, "a", 1, 2);

        let mut first = native_pose(generation, 3, 2, true);
        first["moveSeq"] = json!(2);
        first["turns"] = json!([native_turn(1, 2), native_turn(2, 2)]);
        r.cmd_snake_delta("a", &first).unwrap();
        assert_eq!(r.native_relay.as_ref().unwrap().turn_journals["a"].len(), 2);

        let mut suffix = native_pose(generation, 4, 3, true);
        suffix["moveSeq"] = json!(3);
        suffix["turns"] = json!([native_turn(3, 3)]);
        r.cmd_snake_delta("a", &suffix).unwrap();
        assert_eq!(r.native_relay.as_ref().unwrap().turn_journals["a"].len(), 3);
        assert_eq!(
            r.native_relay.as_ref().unwrap().poses["a"]["turns"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        r.take_outbox();
        r.cmd_resync("b").unwrap();
        let out = r.take_outbox();

        let metadata = out
            .iter()
            .find(|(_, envelope)| envelope.msg_type == "SESSION_START")
            .unwrap();
        assert_eq!(metadata.1.payload["modeKey"], "classic");
        let ready = out
            .iter()
            .find(|(_, envelope)| envelope.msg_type == "COOP_BOARD_READY")
            .unwrap();
        assert_eq!(ready.1.payload["modeKey"], "classic");
        let pose = out
            .iter()
            .find(|(_, envelope)| {
                envelope.msg_type == "SNAKE_DELTA" && envelope.payload["clientId"] == "a"
            })
            .unwrap();
        assert_eq!(pose.1.payload["moveSeq"], 3);
        assert_eq!(pose.1.payload["turns"].as_array().unwrap().len(), 3);
        assert_eq!(pose.1.payload["turns"][2]["turnSeq"], 3);
        assert_eq!(r.native_relay.as_ref().unwrap().last_turn_seq["a"], 3);
    }
}
