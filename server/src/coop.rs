//! Server-authoritative co-op Snake simulation (simplified grid).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const BOARD_W: i32 = 17;
pub const BOARD_H: i32 = 15;
pub const MAX_SNAKES: usize = 4;

/// Y-row offsets from board center by promote order, depending on player count.
/// 1: [0]
/// 2: [-1, +1]
/// 3: [0, +3, -2]
/// 4: [-1, +1, -4, +4]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snake {
    pub client_id: String,
    pub slot: u8,
    pub color_id: u8,
    pub body: Vec<Point>,
    pub dir: Dir,
    pub pending_dir: Option<Dir>,
    pub alive: bool,
    pub grow: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoopGame {
    pub width: i32,
    pub height: i32,
    pub snakes: Vec<Snake>,
    pub apple: Point,
    pub score: u32,
    pub tick: u64,
    pub seq: u64,
    pub running: bool,
    pub ended: bool,
    pub end_reason: Option<String>,
    /// When score reaches this, win (ALL-apples mock). 0 = disabled.
    pub apple_goal: u32,
}

impl CoopGame {
    pub fn new(player_slots: &[(String, u8, u8)], apple_goal: u32) -> Self {
        let cx = BOARD_W / 2;
        let cy = BOARD_H / 2;
        let n = player_slots.len().min(MAX_SNAKES);
        let offsets = spawn_offsets(n);
        let mut snakes = Vec::new();
        for (i, (cid, color_id, slot)) in player_slots.iter().enumerate().take(MAX_SNAKES) {
            let oy = offsets
                .get(*slot as usize)
                .copied()
                .or_else(|| offsets.get(i).copied())
                .unwrap_or(0);
            let y = cy + oy;
            snakes.push(Snake {
                client_id: cid.clone(),
                slot: *slot,
                color_id: *color_id,
                body: vec![
                    Point { x: cx, y },
                    Point { x: cx - 1, y },
                    Point { x: cx - 2, y },
                ],
                dir: Dir::Right,
                pending_dir: None,
                alive: true,
                grow: 0,
            });
        }
        let mut g = Self {
            width: BOARD_W,
            height: BOARD_H,
            snakes,
            apple: Point { x: 3, y: 3 },
            score: 0,
            tick: 0,
            seq: 0,
            running: true,
            ended: false,
            end_reason: None,
            apple_goal,
        };
        g.respawn_apple();
        g
    }

    pub fn set_input(&mut self, client_id: &str, dir: Dir) {
        if let Some(s) = self.snakes.iter_mut().find(|s| s.client_id == client_id) {
            if !s.alive {
                return;
            }
            if dir != s.dir.opposite() {
                s.pending_dir = Some(dir);
            }
        }
    }

    fn occupied(&self) -> Vec<Point> {
        let mut cells = Vec::new();
        for s in &self.snakes {
            cells.extend(s.body.iter().cloned());
        }
        cells
    }

    fn respawn_apple(&mut self) {
        let occ = self.occupied();
        for y in 0..self.height {
            for x in 0..self.width {
                if !occ.iter().any(|p| p.x == x && p.y == y) {
                    // deterministic-ish pick first free then skip by tick
                    let idx = ((self.tick as i32) * 7 + x * 3 + y) % (self.width * self.height);
                    let tx = idx % self.width;
                    let ty = idx / self.width;
                    if !occ.iter().any(|p| p.x == tx && p.y == ty) {
                        self.apple = Point { x: tx, y: ty };
                        return;
                    }
                }
            }
        }
        // fallback
        self.apple = Point { x: 1, y: 1 };
    }

    pub fn step(&mut self) {
        if !self.running || self.ended {
            return;
        }
        self.tick += 1;
        self.seq += 1;

        // Apply pending dirs
        for s in &mut self.snakes {
            if let Some(d) = s.pending_dir.take() {
                if d != s.dir.opposite() {
                    s.dir = d;
                }
            }
        }

        // Proposed heads
        let mut new_heads: Vec<Option<Point>> = Vec::new();
        for s in &self.snakes {
            if !s.alive {
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

        // Resolve deaths — wall / body / other corpses (dead still collide)
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
            // Hit any body cell (including own unless we allow tail leave — use full body before move)
            let hit = all_bodies.iter().any(|(si, p)| {
                p.x == nh.x
                    && p.y == nh.y
                    && !(
                        // allow moving into own tail if not growing
                        *si == i
                            && s.grow == 0
                            && s.body.last().map(|t| t.x == nh.x && t.y == nh.y).unwrap_or(false)
                    )
            });
            // Also head-on with another new head
            let head_on = new_heads.iter().enumerate().any(|(j, oh)| {
                j != i && oh.as_ref().map(|p| p.x == nh.x && p.y == nh.y).unwrap_or(false)
            });
            if hit || head_on {
                self.snakes[i].alive = false;
            }
        }

        // Move survivors
        for (i, maybe_head) in new_heads.into_iter().enumerate() {
            if !self.snakes[i].alive {
                continue; // corpse stays put
            }
            let Some(nh) = maybe_head else { continue };
            let ate = nh.x == self.apple.x && nh.y == self.apple.y;
            self.snakes[i].body.insert(0, nh);
            if ate {
                self.snakes[i].grow += 1;
                self.score += 1;
                self.respawn_apple();
            }
            if self.snakes[i].grow > 0 {
                self.snakes[i].grow -= 1;
            } else if self.snakes[i].body.len() > 1 {
                self.snakes[i].body.pop();
            }
        }

        if self.apple_goal > 0 && self.score >= self.apple_goal {
            self.ended = true;
            self.running = false;
            self.end_reason = Some("ALL_APPLES".into());
            return;
        }

        if self.snakes.iter().all(|s| !s.alive) {
            self.ended = true;
            self.running = false;
            self.end_reason = Some("ALL_DEAD".into());
        }
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "width": self.width,
            "height": self.height,
            "snakes": self.snakes,
            "apple": self.apple,
            "score": self.score,
            "tick": self.tick,
            "seq": self.seq,
            "running": self.running,
            "ended": self.ended,
            "endReason": self.end_reason,
            "appleGoal": self.apple_goal,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_offsets() {
        assert_eq!(super::spawn_offsets(1), &[0]);
        assert_eq!(super::spawn_offsets(2), &[-1, 1]);
        assert_eq!(super::spawn_offsets(3), &[0, 3, -2]);
        assert_eq!(super::spawn_offsets(4), &[-1, 1, -4, 4]);

        let g2 = CoopGame::new(&[("a".into(), 0, 0), ("b".into(), 1, 1)], 0);
        assert_eq!(g2.snakes[0].body[0].y, BOARD_H / 2 - 1);
        assert_eq!(g2.snakes[1].body[0].y, BOARD_H / 2 + 1);

        let g3 = CoopGame::new(
            &[
                ("a".into(), 0, 0),
                ("b".into(), 1, 1),
                ("c".into(), 2, 2),
            ],
            0,
        );
        assert_eq!(g3.snakes[0].body[0].y, BOARD_H / 2);
        assert_eq!(g3.snakes[1].body[0].y, BOARD_H / 2 + 3);
        assert_eq!(g3.snakes[2].body[0].y, BOARD_H / 2 - 2);

        let g4 = CoopGame::new(
            &[
                ("a".into(), 0, 0),
                ("b".into(), 1, 1),
                ("c".into(), 2, 2),
                ("d".into(), 3, 3),
            ],
            0,
        );
        assert_eq!(g4.snakes[0].body[0].y, BOARD_H / 2 - 1);
        assert_eq!(g4.snakes[1].body[0].y, BOARD_H / 2 + 1);
        assert_eq!(g4.snakes[2].body[0].y, BOARD_H / 2 - 4);
        assert_eq!(g4.snakes[3].body[0].y, BOARD_H / 2 + 4);
    }

    #[test]
    fn corpse_stays_and_all_dead_ends() {
        let mut g = CoopGame::new(&[("a".into(), 0, 0)], 0);
        // Drive into wall
        g.snakes[0].dir = Dir::Left;
        for _ in 0..20 {
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
    fn apple_goal_wins() {
        let mut g = CoopGame::new(&[("a".into(), 0, 0)], 1);
        g.apple = Point {
            x: g.snakes[0].body[0].x + 1,
            y: g.snakes[0].body[0].y,
        };
        g.snakes[0].dir = Dir::Right;
        g.step();
        assert!(g.ended);
        assert_eq!(g.end_reason.as_deref(), Some("ALL_APPLES"));
    }
}
