pub mod colors;
pub mod coop;
pub mod protocol;
pub mod room;
pub mod upnp;

/// Room loop period (flush / GC / server-sim accum). Pose cadence is client `Fb`.
pub const ROOM_TICK_MS: u64 = 16;

#[cfg(test)]
mod tick_tests {
    #[test]
    fn room_tick_ms_is_high_frequency() {
        assert_eq!(crate::ROOM_TICK_MS, 16);
    }
}
