//! Shared Remix/Pudding snake color palette.

use serde::{Deserialize, Serialize};

pub const REGULAR_COLORS: u8 = 35;
pub const ALL_COLORS_LENGTH: u8 = 46;
pub const RANDOM_COLOR_ID: u8 = 46;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorKind {
    Solid,
    Rainbow,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnakeColor {
    pub id: u8,
    pub name: &'static str,
    pub kind: ColorKind,
}

pub static SNAKE_COLORS: &[SnakeColor] = &[
    SnakeColor { id: 0, name: "Blue", kind: ColorKind::Solid },
    SnakeColor { id: 1, name: "Cyan", kind: ColorKind::Solid },
    SnakeColor { id: 2, name: "Purple", kind: ColorKind::Solid },
    SnakeColor { id: 3, name: "Pink", kind: ColorKind::Solid },
    SnakeColor { id: 4, name: "Red", kind: ColorKind::Solid },
    SnakeColor { id: 5, name: "Orange", kind: ColorKind::Solid },
    SnakeColor { id: 6, name: "Yellow", kind: ColorKind::Solid },
    SnakeColor { id: 7, name: "Green", kind: ColorKind::Solid },
    SnakeColor { id: 8, name: "Gray", kind: ColorKind::Solid },
    SnakeColor { id: 9, name: "White", kind: ColorKind::Solid },
    SnakeColor { id: 10, name: "Default Rainbow", kind: ColorKind::Rainbow },
    SnakeColor { id: 11, name: "Blue Red", kind: ColorKind::Solid },
    SnakeColor { id: 12, name: "Purple Orange", kind: ColorKind::Solid },
    SnakeColor { id: 13, name: "Pink Yellow", kind: ColorKind::Solid },
    SnakeColor { id: 14, name: "Yellow Green", kind: ColorKind::Solid },
    SnakeColor { id: 15, name: "Green Blue", kind: ColorKind::Solid },
    SnakeColor { id: 16, name: "Gray White", kind: ColorKind::Solid },
    SnakeColor { id: 17, name: "White Gray", kind: ColorKind::Solid },
    SnakeColor { id: 18, name: "Black", kind: ColorKind::Solid },
    SnakeColor { id: 19, name: "Neon Red", kind: ColorKind::Solid },
    SnakeColor { id: 20, name: "Neon Blue", kind: ColorKind::Solid },
    SnakeColor { id: 21, name: "Neon Green", kind: ColorKind::Solid },
    SnakeColor { id: 22, name: "White Black", kind: ColorKind::Solid },
    SnakeColor { id: 23, name: "Black White", kind: ColorKind::Solid },
    SnakeColor { id: 24, name: "Nep Purple", kind: ColorKind::Solid },
    SnakeColor { id: 25, name: "Noire Blue", kind: ColorKind::Solid },
    SnakeColor { id: 26, name: "Pitch Black", kind: ColorKind::Solid },
    SnakeColor { id: 27, name: "Purple Heart", kind: ColorKind::Solid },
    SnakeColor { id: 28, name: "Brown", kind: ColorKind::Solid },
    SnakeColor { id: 29, name: "Extra Brown", kind: ColorKind::Solid },
    SnakeColor { id: 30, name: "Gold", kind: ColorKind::Solid },
    SnakeColor { id: 31, name: "Silver", kind: ColorKind::Solid },
    SnakeColor { id: 32, name: "Dark Teal", kind: ColorKind::Solid },
    SnakeColor { id: 33, name: "Hotpink", kind: ColorKind::Solid },
    SnakeColor { id: 34, name: "Navy Blue", kind: ColorKind::Solid },
    SnakeColor { id: 35, name: "Pride", kind: ColorKind::Rainbow },
    SnakeColor { id: 36, name: "Bisexual", kind: ColorKind::Rainbow },
    SnakeColor { id: 37, name: "Transgender", kind: ColorKind::Rainbow },
    SnakeColor { id: 38, name: "Pansexual", kind: ColorKind::Rainbow },
    SnakeColor { id: 39, name: "Asexual", kind: ColorKind::Rainbow },
    SnakeColor { id: 40, name: "Aromantic", kind: ColorKind::Rainbow },
    SnakeColor { id: 41, name: "Intersex", kind: ColorKind::Rainbow },
    SnakeColor { id: 42, name: "Lesbian", kind: ColorKind::Rainbow },
    SnakeColor { id: 43, name: "Non-binary", kind: ColorKind::Rainbow },
    SnakeColor { id: 44, name: "Monochrome", kind: ColorKind::Rainbow },
    SnakeColor { id: 45, name: "Catalonia", kind: ColorKind::Rainbow },
    SnakeColor { id: 46, name: "Random", kind: ColorKind::Random },
];

pub fn get_color(id: u8) -> Option<&'static SnakeColor> {
    SNAKE_COLORS.iter().find(|c| c.id == id)
}

pub fn color_name(id: u8) -> &'static str {
    get_color(id).map(|c| c.name).unwrap_or("Spectator")
}

pub fn is_claimable(id: u8) -> bool {
    matches!(
        get_color(id).map(|c| c.kind),
        Some(ColorKind::Solid) | Some(ColorKind::Rainbow)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_has_claimables_and_random() {
        assert!(is_claimable(0));
        assert!(is_claimable(10));
        assert!(is_claimable(45));
        assert!(!is_claimable(46));
        assert_eq!(color_name(35), "Pride");
        assert_eq!(SNAKE_COLORS.len(), 47);
    }
}
