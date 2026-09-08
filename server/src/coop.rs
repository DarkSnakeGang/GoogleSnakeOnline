//! Server-authoritative co-op Snake (Plan 1: Classic + Dice + speed + size).
//!
//! Clients send direction only (`COOP_INPUT` / `INPUT`). This module owns bodies,
//! fruit, grow-on-eat, collision, respawn, and all-apples.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;

pub const MAX_SNAKES: usize = 4;

/// Normal / Fast / Slow step intervals (ms), aligned with stock cadence intent.
pub fn speed_interval_ms(speed_index: u8) -> u64 {
    match speed_index {
        1 => 85,  // Fast
        2 => 200, // Slow
        _ => 142, // Normal
    }
}

pub fn board_dims(size_index: u8) -> (i32, i32) {
    match size_index {
        1 => (10, 9),  // Small
        2 => (24, 21), // Large
        _ => (17, 15), // Standard
    }
}

/// Simultaneous fruit floor by count index (Pudding COUNT_MINIMA).
/// Dice/Bomb keep 1 on the board (not a dice roll for co-op Plan 1).
pub fn count_target(count_index: u8, _rng: &mut u64) -> u32 {
    match count_index {
        0 => 1,  // 1a
        1 => 3,  // 3a
        2 => 5,  // 5a
        3 => 10, // 10a
        4 => 1,  // Dice — starts/refills at 1
        5 => 1,  // Bomb — starts/refills at 1
        _ => 1,
    }
}

/// Classic apple reset (`aT` in Google Snake desktop) for 1a / 3a / 5a.
/// Base: (floor(3w/4)+dx, floor(h/2)+dy).
/// 10a uses the 5a layout then fills to 10. Dice/Bomb: single aT(0,0).
fn classic_initial_fruit(width: i32, height: i32, count_index: u8) -> Vec<Point> {
    if width <= 0 || height <= 0 {
        return Vec::new();
    }
    let base_x = (3 * width) / 4;
    let base_y = height / 2;
    let at = |dx: i32, dy: i32| Point {
        x: base_x + dx,
        y: base_y + dy,
    };
    match count_index {
        // 1a, Dice, Bomb — one apple at aT(0,0)
        0 | 4 | 5 => vec![at(0, 0)],
        // 3a
        1 => vec![at(0, 0), at(-2, -2), at(-2, 2)],
        // 5a, and the first five of 10a
        2 | 3 => {
            let mut pts = vec![at(0, 0), at(-2, -2), at(-2, 2), at(2, -2), at(2, 2)];
            let shift = if width >= 20 { 2 } else { 1 };
            for p in &mut pts {
                p.x -= shift;
            }
            pts
        }
        _ => Vec::new(),
    }
}

fn next_rng(state: &mut u64) -> u64 {
    // xorshift64*
    let mut x = *state;
    if x == 0 {
        x = 0x9E3779B97F4A7C15;
    }
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

/// Y-row offsets from board center by player count.
pub fn spawn_offsets(player_count: usize) -> &'static [i32] {
    match player_count {
        0 | 1 => &[0],
        2 => &[-1, 1],
        3 => &[0, 3, -2],
        _ => &[-1, 1, -4, 4],
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

impl Dir {
    pub fn delta(self) -> (i32, i32) {
        match self {
            Dir::Up => (0, -1),
            Dir::Down => (0, 1),
            Dir::Left => (-1, 0),
            Dir::Right => (1, 0),
        }
    }

    pub fn opposite(self) -> Dir {
        match self {
            Dir::Up => Dir::Down,
            Dir::Down => Dir::Up,
            Dir::Left => Dir::Right,
            Dir::Right => Dir::Left,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Dir::Up => "UP",
            Dir::Down => "DOWN",
            Dir::Left => "LEFT",
            Dir::Right => "RIGHT",
        }
    }

    pub fn from_str(s: &str) -> Option<Dir> {
        match s.to_ascii_uppercase().as_str() {
            "UP" => Some(Dir::Up),
            "DOWN" => Some(Dir::Down),
            "LEFT" => Some(Dir::Left),
            "RIGHT" => Some(Dir::Right),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fruit {
    pub x: i32,
    pub y: i32,
    pub type_id: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snake {
    pub client_id: String,
    pub slot: u8,
    pub color_id: u8,
    pub body: Vec<Point>,
    pub dir: Dir,
    /// Buffered turns (max 2) — stock Snake queues one move ahead.
    #[serde(default)]
    pub pending_dirs: VecDeque<Dir>,
    pub alive: bool,
    pub grow: u32,
    pub score: u32,
    /// Idle at spawn until this client sends COOP_INPUT. Prevents one player's
    /// first key from crawling every snake (all spawn facing RIGHT).
    #[serde(default)]
    pub started: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoopGame {
    pub width: i32,
    pub height: i32,
    pub snakes: Vec<Snake>,
    pub fruit: Vec<Fruit>,
    pub score: u32,
    pub tick: u64,
    pub seq: u64,
    pub running: bool,
    pub ended: bool,
    pub end_reason: Option<String>,
    pub count_index: u8,
    pub speed_index: u8,
    pub size_index: u8,
    /// Desired simultaneous fruit count for this run (Dice roll frozen at start).
    pub fruit_target: u32,
    /// Admin apple setting index → fruit type_id.
    pub apple_type: i32,
    pub rng: u64,
}

/// Config captured from room settings at SESSION_START.
#[derive(Clone)]
pub struct CoopStartConfig {
    pub size_index: u8,
    pub count_index: u8,
    pub speed_index: u8,
    pub apple_type: i32,
    pub seed: u64,
}

impl Default for CoopStartConfig {
    fn default() -> Self {
        Self {
            size_index: 0,
            count_index: 0,
            speed_index: 0,
            apple_type: 0,
            seed: 1,
        }
    }
}

impl CoopStartConfig {
    pub fn from_settings(settings: &Value, seed: u64) -> Self {
        fn idx(settings: &Value, key: &str) -> u8 {
            let v = settings.get(key);
            // Accept number or numeric string ("1" → 1) from client JSON
            if let Some(n) = v.and_then(|x| x.as_u64().or_else(|| x.as_i64().map(|n| n as u64))) {
                return n.min(255) as u8;
            }
            if let Some(s) = v.and_then(|x| x.as_str()) {
                if let Ok(n) = s.trim().parse::<u64>() {
                    return n.min(255) as u8;
                }
            }
            0
        }
        Self {
            size_index: idx(settings, "size"),
            count_index: idx(settings, "count"),
            speed_index: idx(settings, "speed"),
            apple_type: {
                let v = settings.get("apple").or_else(|| settings.get("appleIndex"));
                v.and_then(|x| {
                    x.as_i64()
                        .or_else(|| x.as_u64().map(|n| n as i64))
                        .or_else(|| x.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
                })
                .unwrap_or(0) as i32
            },
            seed: if seed == 0 { 1 } else { seed },
        }
    }
}

impl CoopGame {
    /// `player_slots`: (client_id, color_id, slot_index)
    pub fn new(player_slots: &[(String, u8, u8)], cfg: CoopStartConfig) -> Self {
        let (bw, bh) = board_dims(cfg.size_index);
        let cx = bw / 2;
        let cy = bh / 2;
        let n = player_slots.len().min(MAX_SNAKES);
        let offsets = spawn_offsets(n);
        let mut snakes = Vec::new();
        for (i, (cid, color_id, slot)) in player_slots.iter().enumerate().take(MAX_SNAKES) {
            let oy = offsets
                .get(*slot as usize)
                .copied()
                .or_else(|| offsets.get(i).copied())
                .unwrap_or(0);
            let mut y = cy + oy;
            if y < 1 {
                y = 1;
            }
            if y >= bh - 1 {
                y = bh - 2;
            }
            let mut x_head = cx;
            if x_head < 2 {
                x_head = 2;
            }
            snakes.push(Snake {
                client_id: cid.clone(),
                slot: *slot,
                color_id: *color_id,
                body: vec![
                    Point { x: x_head, y },
                    Point { x: x_head - 1, y },
                    Point { x: x_head - 2, y },
                ],
                dir: Dir::Right,
                pending_dirs: VecDeque::new(),
                alive: true,
                grow: 0,
                score: 0,
                started: false,
            });
        }
        let mut rng = cfg.seed;
        let fruit_target = count_target(cfg.count_index, &mut rng);
        let mut g = Self {
            width: bw,
            height: bh,
            snakes,
            fruit: Vec::new(),
            score: 0,
            tick: 0,
            seq: 0,
            // Room gates stepping on first input; unit tests call step() directly.
            running: true,
            ended: false,
            end_reason: None,
            count_index: cfg.count_index,
            speed_index: cfg.speed_index,
            size_index: cfg.size_index,
            fruit_target,
            apple_type: cfg.apple_type,
            rng,
        };
        g.plant_initial_fruit();
        g
    }

    pub fn interval_ms(&self) -> u64 {
        speed_interval_ms(self.speed_index)
    }

    pub fn set_input(&mut self, client_id: &str, dir: Dir) {
        if self.ended {
            return;
        }
        if let Some(s) = self.snakes.iter_mut().find(|s| s.client_id == client_id) {
            if !s.alive {
                return;
            }
            // First key arms this snake + the shared crawl (room also gates ticks)
            self.running = true;
            s.started = true;
            // Effective facing for 180° rejection: last buffered turn, else current
            let facing = s.pending_dirs.back().copied().unwrap_or(s.dir);
            if dir == facing.opposite() {
                return;
            }
            // Drop duplicate of the last queued / current facing
            if let Some(last) = s.pending_dirs.back() {
                if *last == dir {
                    return;
                }
            } else if dir == s.dir {
                // Same as current with empty buffer — still queue so crawl starts
                // with an explicit turn even when already facing that way? Stock
                // ignores no-ops; first start already set started=true.
                return;
            }
            if s.pending_dirs.len() >= 2 {
                // Replace the buffered (second) slot — keep the imminent turn
                if let Some(back) = s.pending_dirs.back_mut() {
                    *back = dir;
                }
            } else {
                s.pending_dirs.push_back(dir);
            }
        }
    }

    #[allow(dead_code)]
    fn occupied(&self) -> Vec<Point> {
        let mut cells = Vec::new();
        for s in &self.snakes {
            cells.extend(s.body.iter().cloned());
        }
        for f in &self.fruit {
            cells.push(Point { x: f.x, y: f.y });
        }
        cells
    }

    fn occupied_snakes_only(&self) -> Vec<Point> {
        let mut cells = Vec::new();
        for s in &self.snakes {
            cells.extend(s.body.iter().cloned());
        }
        cells
    }

    fn cell_free_for_fruit(&self, x: i32, y: i32, ignore_fruit: bool) -> bool {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return false;
        }
        for s in &self.snakes {
            if s.body.iter().any(|p| p.x == x && p.y == y) {
                return false;
            }
        }
        if !ignore_fruit && self.fruit.iter().any(|f| f.x == x && f.y == y) {
            return false;
        }
        true
    }

    /// Pick a free cell (Classic: any empty cell). Returns None if board full.
    fn pick_free_cell(&mut self) -> Option<Point> {
        if self.width <= 0 || self.height <= 0 {
            return None;
        }
        let mut free: Vec<Point> = Vec::new();
        for y in 0..self.height {
            for x in 0..self.width {
                if self.cell_free_for_fruit(x, y, false) {
                    free.push(Point { x, y });
                }
            }
        }
        if free.is_empty() {
            return None;
        }
        let r = next_rng(&mut self.rng);
        let idx = (r as usize) % free.len();
        Some(free[idx].clone())
    }

    fn spawn_one_fruit(&mut self) -> bool {
        if let Some(p) = self.pick_free_cell() {
            self.fruit.push(Fruit {
                x: p.x,
                y: p.y,
                type_id: self.apple_type,
            });
            true
        } else {
            false
        }
    }

    /// Plant Classic aT stock, then fill to fruit_target (so 10a ends at 10).
    fn plant_initial_fruit(&mut self) {
        self.fruit.clear();
        let stock = classic_initial_fruit(self.width, self.height, self.count_index);
        for p in stock {
            if self.cell_free_for_fruit(p.x, p.y, false) {
                self.fruit.push(Fruit {
                    x: p.x,
                    y: p.y,
                    type_id: self.apple_type,
                });
            }
        }
        self.fill_fruit_to_target();
    }

    fn fill_fruit_to_target(&mut self) {
        while (self.fruit.len() as u32) < self.fruit_target {
            if !self.spawn_one_fruit() {
                break;
            }
        }
    }

    fn end_all_apples(&mut self) {
        self.ended = true;
        self.running = false;
        self.end_reason = Some("ALL_APPLES".into());
    }

    fn end_all_dead(&mut self) {
        self.ended = true;
        self.running = false;
        self.end_reason = Some("ALL_DEAD".into());
    }

    pub fn step(&mut self) {
        if !self.running || self.ended {
            return;
        }
        self.tick += 1;
        self.seq += 1;

        for s in &mut self.snakes {
            if let Some(d) = s.pending_dirs.pop_front() {
                if d != s.dir.opposite() {
                    s.dir = d;
                }
            }
        }

        let mut new_heads: Vec<Option<Point>> = Vec::new();
        for s in &self.snakes {
            if !s.alive || !s.started {
                // Unstarted snakes stay parked — still occupy cells for collision
                new_heads.push(None);
                continue;
            }
            let (dx, dy) = s.dir.delta();
            let head = &s.body[0];
            new_heads.push(Some(Point {
                x: head.x + dx,
                y: head.y + dy,
            }));
        }

        let all_bodies: Vec<(usize, Point)> = self
            .snakes
            .iter()
            .enumerate()
            .flat_map(|(i, s)| s.body.iter().cloned().map(move |p| (i, p)))
            .collect();

        for (i, maybe_head) in new_heads.iter().enumerate() {
            let Some(nh) = maybe_head else { continue };
            let s = &self.snakes[i];
            if nh.x < 0 || nh.y < 0 || nh.x >= self.width || nh.y >= self.height {
                self.snakes[i].alive = false;
                continue;
            }
            let hit = all_bodies.iter().any(|(si, p)| {
                p.x == nh.x
                    && p.y == nh.y
                    && !(*si == i
                        && s.grow == 0
                        && s.body
                            .last()
                            .map(|t| t.x == nh.x && t.y == nh.y)
                            .unwrap_or(false))
            });
            let head_on = new_heads.iter().enumerate().any(|(j, oh)| {
                j != i
                    && oh
                        .as_ref()
                        .map(|p| p.x == nh.x && p.y == nh.y)
                        .unwrap_or(false)
            });
            if hit || head_on {
                self.snakes[i].alive = false;
            }
        }

        let mut ate_any = false;
        for (i, maybe_head) in new_heads.into_iter().enumerate() {
            if !self.snakes[i].alive {
                continue;
            }
            let Some(nh) = maybe_head else { continue };
            let fruit_idx = self.fruit.iter().position(|f| f.x == nh.x && f.y == nh.y);
            self.snakes[i].body.insert(0, nh);
            if let Some(fi) = fruit_idx {
                self.fruit.remove(fi);
                self.snakes[i].grow += 1;
                self.snakes[i].score += 1;
                self.score += 1;
                ate_any = true;
            }
            if self.snakes[i].grow > 0 {
                self.snakes[i].grow -= 1;
            } else if self.snakes[i].body.len() > 1 {
                self.snakes[i].body.pop();
            }
        }

        if ate_any {
            // Keep simultaneous fruit at target (1/3/5/10/Dice). Eating apples
            // must respawn — ALL_APPLES only when no free cell remains at all.
            self.fill_fruit_to_target();
            if self.fruit.is_empty() {
                if self.pick_free_cell().is_none() {
                    self.end_all_apples();
                    return;
                }
                // Free cell exists but fill missed — force one spawn
                let _ = self.spawn_one_fruit();
                if self.fruit.is_empty() && self.pick_free_cell().is_none() {
                    self.end_all_apples();
                    return;
                }
            }
        }

        if self.snakes.iter().all(|s| !s.alive) {
            // Idle (never-started) snakes stay alive — they can still press a
            // key. Do not end just because everyone who already moved is dead.
            self.end_all_dead();
        }
    }

    pub fn snapshot(&self) -> Value {
        let snakes: Vec<Value> = self
            .snakes
            .iter()
            .map(|s| {
                json!({
                    "clientId": s.client_id,
                    "slot": s.slot,
                    "colorId": s.color_id,
                    "body": s.body,
                    "dir": s.dir.as_str(),
                    "alive": s.alive,
                    "score": s.score,
                })
            })
            .collect();
        let fruit: Vec<Value> = self
            .fruit
            .iter()
            .map(|f| {
                json!({
                    "x": f.x,
                    "y": f.y,
                    "type": f.type_id,
                })
            })
            .collect();
        json!({
            "width": self.width,
            "height": self.height,
            "snakes": snakes,
            "fruit": fruit,
            "apples": fruit,
            "score": self.score,
            "tick": self.tick,
            "seq": self.seq,
            "running": self.running,
            "ended": self.ended,
            "endReason": self.end_reason,
            "countIndex": self.count_index,
            "speedIndex": self.speed_index,
            "sizeIndex": self.size_index,
            "fruitTarget": self.fruit_target,
            "intervalMs": self.interval_ms(),
        })
    }
}

// Legacy alias for older tests that used BOARD_W/H
pub const BOARD_W: i32 = 17;
pub const BOARD_H: i32 = 15;

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_default() -> CoopStartConfig {
        CoopStartConfig {
            seed: 42,
            ..Default::default()
        }
    }

    fn arm_all(g: &mut CoopGame) {
        for s in &mut g.snakes {
            s.started = true;
        }
    }

    #[test]
    fn spawn_offsets_layout() {
        assert_eq!(super::spawn_offsets(2), &[-1, 1]);
        let g = CoopGame::new(&[("a".into(), 0, 0), ("b".into(), 1, 1)], cfg_default());
        assert_eq!(g.width, 17);
        assert_eq!(g.height, 15);
        assert_eq!(g.snakes[0].body[0].y, 15 / 2 - 1);
        assert_eq!(g.snakes[1].body[0].y, 15 / 2 + 1);
        assert!(!g.snakes[0].started);
        assert!(!g.snakes[1].started);
    }

    #[test]
    fn start_config_reads_apple_and_size() {
        let cfg = CoopStartConfig::from_settings(
            &serde_json::json!({"size": 1, "count": 0, "speed": 0, "apple": 3}),
            42,
        );
        assert_eq!(cfg.size_index, 1);
        assert_eq!(cfg.apple_type, 3);
        let (w, h) = board_dims(cfg.size_index);
        assert_eq!((w, h), (10, 9));
        let cfg2 =
            CoopStartConfig::from_settings(&serde_json::json!({"size": "1", "apple": "2"}), 1);
        assert_eq!(cfg2.size_index, 1);
        assert_eq!(cfg2.apple_type, 2);
    }

    #[test]
    fn grow_on_eat() {
        let mut g = CoopGame::new(&[("a".into(), 0, 0)], cfg_default());
        arm_all(&mut g);
        let len0 = g.snakes[0].body.len();
        let head = g.snakes[0].body[0].clone();
        g.fruit = vec![Fruit {
            x: head.x + 1,
            y: head.y,
            type_id: 0,
        }];
        g.fruit_target = 1;
        g.snakes[0].dir = Dir::Right;
        g.step();
        assert_eq!(g.snakes[0].body.len(), len0 + 1);
        assert!(g.score >= 1);
        // Count=1: respawn a replacement — do not instantly ALL_APPLES
        assert!(!g.ended, "eat must not end the run when free cells remain");
        assert_eq!(g.fruit.len(), 1, "server must refill to fruit_target");
    }

    #[test]
    fn stock_fruit_stable_per_count_size() {
        let mut cfg = cfg_default();
        cfg.count_index = 1; // 3 apples
        cfg.size_index = 0;
        cfg.seed = 1;
        let g1 = CoopGame::new(&[("a".into(), 0, 0)], cfg.clone());
        cfg.seed = 99999;
        let g2 = CoopGame::new(&[("a".into(), 0, 0)], cfg);
        assert_eq!(g1.fruit.len(), 3);
        assert_eq!(g2.fruit.len(), 3);
        let coords = |g: &CoopGame| {
            let mut v: Vec<(i32, i32)> = g.fruit.iter().map(|f| (f.x, f.y)).collect();
            v.sort();
            v
        };
        assert_eq!(
            coords(&g1),
            coords(&g2),
            "Classic stock starts must ignore RNG seed"
        );
    }

    #[test]
    fn stock_fruit_respawn_can_differ() {
        let mut cfg = cfg_default();
        cfg.count_index = 0;
        let mut g = CoopGame::new(&[("a".into(), 0, 0)], cfg);
        arm_all(&mut g);
        assert_eq!(g.fruit.len(), 1);
        let start = (g.fruit[0].x, g.fruit[0].y);
        g.fruit.clear();
        // Force many random respawns — should eventually leave the stock cell
        let mut seen_other = false;
        for _ in 0..40 {
            g.fruit.clear();
            assert!(g.spawn_one_fruit());
            if (g.fruit[0].x, g.fruit[0].y) != start {
                seen_other = true;
                break;
            }
        }
        assert!(
            seen_other,
            "respawns must use random free cells, not only stock"
        );
    }

    #[test]
    fn fruit_spawn_not_corner_biased() {
        let mut g = CoopGame::new(&[("a".into(), 0, 0)], cfg_default());
        g.fruit.clear();
        let mut corner = 0;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..80 {
            g.fruit.clear();
            assert!(g.spawn_one_fruit());
            let p = &g.fruit[0];
            seen.insert((p.x, p.y));
            if p.x == 0 && p.y == 0 {
                corner += 1;
            }
        }
        assert!(
            seen.len() >= 20,
            "expected diverse free-cell picks, got {}",
            seen.len()
        );
        assert!(
            corner < 15,
            "corner (0,0) should not dominate spawns (got {corner}/80)"
        );
    }

    #[test]
    fn eat_three_on_small_board_keeps_refilling() {
        let mut cfg = cfg_default();
        cfg.count_index = 1; // 3 apples
        cfg.size_index = 1; // 10×9
        let mut g = CoopGame::new(&[("a".into(), 0, 0), ("b".into(), 1, 1)], cfg);
        arm_all(&mut g);
        assert_eq!((g.width, g.height), (10, 9));
        assert_eq!(g.fruit_target, 3);
        assert_eq!(g.fruit.len(), 3);
        // Eat 6 apples one-by-one — each eat must refill to 3, never ALL_APPLES
        for n in 0..6 {
            assert!(!g.ended, "ended early at eat {n}: {:?}", g.end_reason);
            // Park snake mid-board so stepping right never hits the border
            g.snakes[0].body = vec![
                Point { x: 4, y: 4 },
                Point { x: 3, y: 4 },
                Point { x: 2, y: 4 },
            ];
            g.snakes[0].dir = Dir::Right;
            g.snakes[0].pending_dirs.clear();
            g.snakes[0].alive = true;
            g.fruit[0].x = 5;
            g.fruit[0].y = 4;
            for f in g.fruit.iter_mut().skip(1) {
                f.x = 0;
                f.y = 0;
            }
            g.step();
            assert!(
                !g.ended || g.end_reason.as_deref() != Some("ALL_APPLES"),
                "ALL_APPLES after eat #{n}"
            );
            assert_eq!(
                g.fruit.len(),
                3,
                "after eat #{n} fruit must refill to 3, got {}",
                g.fruit.len()
            );
        }
        assert_ne!(g.end_reason.as_deref(), Some("ALL_APPLES"));
    }

    #[test]
    fn eat_refills_three_apples() {
        let mut cfg = cfg_default();
        cfg.count_index = 1; // 3 apples
        let mut g = CoopGame::new(&[("a".into(), 0, 0)], cfg);
        arm_all(&mut g);
        assert_eq!(g.fruit_target, 3);
        assert_eq!(g.fruit.len(), 3);
        let head = g.snakes[0].body[0].clone();
        // Put one fruit directly ahead so the step eats it
        g.fruit[0] = Fruit {
            x: head.x + 1,
            y: head.y,
            type_id: 0,
        };
        g.snakes[0].dir = Dir::Right;
        g.step();
        assert!(!g.ended);
        assert_eq!(g.fruit.len(), 3);
    }

    #[test]
    fn corpse_and_all_dead() {
        let mut g = CoopGame::new(&[("a".into(), 0, 0)], cfg_default());
        arm_all(&mut g);
        g.snakes[0].dir = Dir::Left;
        for _ in 0..30 {
            g.step();
            if g.ended {
                break;
            }
        }
        assert!(g.ended);
        assert_eq!(g.end_reason.as_deref(), Some("ALL_DEAD"));
        assert!(!g.snakes[0].body.is_empty());
    }

    #[test]
    fn speed_intervals() {
        assert_eq!(speed_interval_ms(0), 142);
        assert_eq!(speed_interval_ms(1), 85);
        assert_eq!(speed_interval_ms(2), 200);
    }

    #[test]
    fn input_pending_turn() {
        let mut g = CoopGame::new(&[("a".into(), 0, 0)], cfg_default());
        g.set_input("a", Dir::Up);
        assert!(g.snakes[0].started);
        assert_eq!(
            g.snakes[0].pending_dirs.iter().copied().collect::<Vec<_>>(),
            vec![Dir::Up]
        );
        // Opposite of buffered facing (Up) is ignored
        g.set_input("a", Dir::Down);
        assert_eq!(
            g.snakes[0].pending_dirs.iter().copied().collect::<Vec<_>>(),
            vec![Dir::Up]
        );
        // Second slot buffers the next turn
        g.set_input("a", Dir::Left);
        assert_eq!(
            g.snakes[0].pending_dirs.iter().copied().collect::<Vec<_>>(),
            vec![Dir::Up, Dir::Left]
        );
    }

    #[test]
    fn classic_at_fruit_standard_count3() {
        let mut cfg = cfg_default();
        cfg.count_index = 1;
        cfg.size_index = 0;
        let g = CoopGame::new(&[("a".into(), 0, 0)], cfg);
        let mut coords: Vec<(i32, i32)> = g.fruit.iter().map(|f| (f.x, f.y)).collect();
        coords.sort();
        assert_eq!(coords, vec![(10, 5), (10, 9), (12, 7)]);
    }

    #[test]
    fn classic_at_fruit_count1_10_dice() {
        let mut cfg = cfg_default();
        cfg.count_index = 0;
        let g1 = CoopGame::new(&[("a".into(), 0, 0)], cfg.clone());
        assert_eq!(g1.fruit.len(), 1);
        assert_eq!((g1.fruit[0].x, g1.fruit[0].y), (12, 7));

        cfg.count_index = 3; // 10a — ten on the board at start
        let g10 = CoopGame::new(&[("a".into(), 0, 0)], cfg.clone());
        assert_eq!(g10.fruit_target, 10);
        assert_eq!(g10.fruit.len(), 10);
        assert!(
            g10.fruit.iter().any(|f| f.x == 11 && f.y == 7),
            "10a should include Classic 5a aT core"
        );

        cfg.count_index = 4; // Dice — one apple
        let gd = CoopGame::new(&[("a".into(), 0, 0)], cfg.clone());
        assert_eq!(gd.fruit.len(), 1);
        assert_eq!((gd.fruit[0].x, gd.fruit[0].y), (12, 7));

        cfg.count_index = 5; // Bomb — one apple
        let gb = CoopGame::new(&[("a".into(), 0, 0)], cfg);
        assert_eq!(gb.fruit.len(), 1);
        assert_eq!((gb.fruit[0].x, gb.fruit[0].y), (12, 7));
    }

    #[test]
    fn peer_idle_until_own_input() {
        let mut g = CoopGame::new(&[("a".into(), 0, 0), ("b".into(), 1, 1)], cfg_default());
        let b0 = g.snakes[1].body.clone();
        g.set_input("a", Dir::Right);
        g.step();
        assert_ne!(g.snakes[0].body[0].x, g.snakes[0].body[1].x); // a moved
        assert_eq!(
            g.snakes[1].body, b0,
            "peer must stay parked until their input"
        );
        assert!(!g.snakes[1].started);
        g.set_input("b", Dir::Right);
        assert!(g.snakes[1].started);
        g.step();
        assert_ne!(g.snakes[1].body, b0, "peer crawls after their own input");
    }
}
