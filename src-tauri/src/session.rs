use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use uuid::Uuid;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEvent {
    /// Wall-clock nanoseconds since Unix epoch
    pub t: u64,
    /// "down" or "up"
    #[serde(rename = "type")]
    pub kind: String,
    /// HID usage code (keyboard/keypad page 0x07)
    pub key: u32,
    /// Modifier bitmask: bit0=shift, bit1=ctrl, bit2=alt, bit3=cmd
    pub flags: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtraEvent {
    pub t: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LogEntry {
    Key(KeyEvent),
    Extra(ExtraEvent),
}

pub struct SessionState {
    pub session_id: String,
    pub session_nonce: String,
    pub start_wall_ns: u64,
    /// mach_absolute_time() at session start (used for timestamp conversion)
    pub start_mach: u64,
    pub log: Vec<LogEntry>,
}

impl SessionState {
    pub fn new(start_mach: u64) -> Self {
        let start_wall_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64;

        let nonce_bytes: [u8; 32] = rand::random();

        Self {
            session_id: Uuid::new_v4().to_string(),
            session_nonce: hex::encode(nonce_bytes),
            start_wall_ns,
            start_mach,
            log: Vec::new(),
        }
    }

    pub fn append_key(&mut self, event: KeyEvent) {
        self.log.push(LogEntry::Key(event));
    }

    pub fn append_extra(&mut self, event: ExtraEvent) {
        self.log.push(LogEntry::Extra(event));
    }

    pub fn keystroke_count(&self) -> usize {
        self.log.iter().filter(|e| matches!(e, LogEntry::Key(_))).count()
    }

    pub fn to_jsonl(&self) -> String {
        self.log
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Shared state across Tauri commands and HID thread
pub struct AppState {
    pub session: Mutex<SessionState>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_event_serializes() {
        let e = KeyEvent { t: 1_000_000, kind: "down".into(), key: 4, flags: 0 };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"type\":\"down\""));
        assert!(json.contains("\"key\":4"));
    }

    #[test]
    fn test_extra_event_no_nulls() {
        let e = ExtraEvent { t: 1_000, kind: "paste".into(), char_count: Some(10), duration_ms: None };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"char_count\":10"));
        assert!(!json.contains("duration_ms"));
    }

    #[test]
    fn test_session_keystroke_count() {
        let mut s = SessionState::new(0);
        s.append_key(KeyEvent { t: 1, kind: "down".into(), key: 4, flags: 0 });
        s.append_key(KeyEvent { t: 2, kind: "up".into(), key: 4, flags: 0 });
        s.append_extra(ExtraEvent { t: 3, kind: "paste".into(), char_count: Some(5), duration_ms: None });
        assert_eq!(s.keystroke_count(), 2);
    }

    #[test]
    fn test_to_jsonl() {
        let mut s = SessionState::new(0);
        s.append_key(KeyEvent { t: 1, kind: "down".into(), key: 4, flags: 0 });
        s.append_extra(ExtraEvent { t: 2, kind: "paste".into(), char_count: Some(3), duration_ms: None });
        let jsonl = s.to_jsonl();
        let lines: Vec<&str> = jsonl.lines().collect();
        assert_eq!(lines.len(), 2);
        // Each line must be valid JSON
        serde_json::from_str::<serde_json::Value>(lines[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(lines[1]).unwrap();
    }
}
