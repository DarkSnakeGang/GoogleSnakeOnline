//! Versioned JSON protocol envelopes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MsgType {
    Hello,
    Welcome,
    Roster,
    SetRole,
    Kick,
    SetDuration,
    Ready,
    ColorClaim,
    ModeChange,
    SettingsSync,
    PlaySync,
    SessionStart,
    SessionEnd,
    Input,
    StateDelta,
    StateSnapshot,
    ScorePulse,
    AttemptTick,
    AttemptExpired,
    AdminTransfer,
    ResyncRequest,
    BoardDelta,
    BoardSnapshot,
    SpectateFocus,
    Error,
    Ping,
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub ts: Option<i64>,
}

impl Envelope {
    pub fn new(msg_type: &str, payload: Value) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            msg_type: msg_type.to_string(),
            from: None,
            seq: 0,
            payload,
            ts: Some(chrono::Utc::now().timestamp_millis()),
        }
    }

    pub fn with_from(mut self, from: impl Into<String>) -> Self {
        self.from = Some(from.into());
        self
    }

    pub fn with_seq(mut self, seq: u64) -> Self {
        self.seq = seq;
        self
    }
}

pub fn parse_envelope(raw: &str) -> Result<Envelope, String> {
    let env: Envelope = serde_json::from_str(raw).map_err(|e| format!("malformed_json:{e}"))?;
    if env.v != PROTOCOL_VERSION {
        return Err(format!("version_mismatch:got={}", env.v));
    }
    if env.msg_type.is_empty() {
        return Err("missing_type".into());
    }
    Ok(env)
}

pub fn error_envelope(code: &str, message: &str) -> Envelope {
    Envelope::new(
        "ERROR",
        serde_json::json!({ "code": code, "message": message }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_version() {
        let raw = r#"{"v":99,"type":"HELLO","payload":{}}"#;
        assert!(parse_envelope(raw).unwrap_err().contains("version_mismatch"));
    }

    #[test]
    fn accepts_hello() {
        let raw = r#"{"v":1,"type":"HELLO","payload":{"roomCode":"ABCD"}}"#;
        let e = parse_envelope(raw).unwrap();
        assert_eq!(e.msg_type, "HELLO");
    }
}
