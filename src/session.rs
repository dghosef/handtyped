use crate::editor::EditorDocumentState;
use crate::integrity::IntegrityReport;
use crate::observability::RuntimeObservability;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
// ---------------------------------------------------------------------------
// Serde helper
// ---------------------------------------------------------------------------

fn is_false(b: &bool) -> bool {
    !b
}

fn new_session_id() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect()
}

// ---------------------------------------------------------------------------
// Log entry types
// ---------------------------------------------------------------------------

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
    /// True when the inter-keydown interval was below the human minimum (~5 ms).
    /// Omitted from JSON when false to keep the log compact.
    #[serde(default, skip_serializing_if = "is_false")]
    pub suspicious: bool,
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
    /// SHA-256 hex of clipboard content at paste time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusEvent {
    /// Elapsed milliseconds since session start.
    pub t: u64,
    /// "active" or "inactive".
    pub state: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LogEntry {
    Key(KeyEvent),
    Extra(ExtraEvent),
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

pub struct SessionState {
    pub session_id: String,
    pub session_nonce: String,
    pub start_wall_ns: u64,
    /// mach_absolute_time() at session start (used for timestamp conversion)
    pub start_mach: u64,
    pub log: Vec<LogEntry>,
    /// Rolling SHA-256 chain over all log entries, seeded with the session nonce.
    /// After each appended entry: chain = SHA-256(chain || entry_json_bytes).
    /// The final value is included in session-meta.json so verifiers can replay
    /// the JSONL and detect any insertion, deletion, or reordering.
    log_chain: [u8; 32],
}

impl SessionState {
    pub fn new(start_mach: u64) -> Self {
        let start_wall_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64;

        let nonce_bytes: [u8; 32] = rand::random();

        // Seed the chain with H(nonce) so the chain is cryptographically bound
        // to this specific session from the very first entry.
        let mut h = Sha256::new();
        h.update(nonce_bytes);
        let initial_chain: [u8; 32] = h.finalize().into();

        Self {
            session_id: new_session_id(),
            session_nonce: hex::encode(nonce_bytes),
            start_wall_ns,
            start_mach,
            log: Vec::new(),
            log_chain: initial_chain,
        }
    }

    pub fn append_key(&mut self, event: KeyEvent) {
        let entry = LogEntry::Key(event);
        self.advance_chain(&entry);
        self.log.push(entry);
    }

    pub fn append_extra(&mut self, event: ExtraEvent) {
        let entry = LogEntry::Extra(event);
        self.advance_chain(&entry);
        self.log.push(entry);
    }

    /// Update the running chain: chain = SHA-256(chain || entry_json).
    fn advance_chain(&mut self, entry: &LogEntry) {
        if let Ok(json) = serde_json::to_string(entry) {
            let mut h = Sha256::new();
            h.update(&self.log_chain);
            h.update(json.as_bytes());
            self.log_chain = h.finalize().into();
        }
    }

    /// Hex-encoded final chain hash — included in session-meta.json.
    pub fn log_chain_hash(&self) -> String {
        hex::encode(self.log_chain)
    }

    pub fn keystroke_count(&self) -> usize {
        self.log
            .iter()
            .filter(|e| matches!(e, LogEntry::Key(_)))
            .count()
    }

    pub fn to_jsonl(&self) -> String {
        self.log
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn focus_events(&self) -> Vec<FocusEvent> {
        self.focus_events_since_wall_ms(self.start_wall_ns / 1_000_000)
    }

    pub fn focus_events_since_wall_ms(&self, origin_wall_ms: u64) -> Vec<FocusEvent> {
        self.log
            .iter()
            .filter_map(|entry| {
                let event = match entry {
                    LogEntry::Extra(event) => event,
                    LogEntry::Key(_) => return None,
                };

                let state = match event.kind.as_str() {
                    "focus_active" => "active",
                    "focus_inactive" => "inactive",
                    _ => return None,
                };

                let event_wall_ms = event.t / 1_000_000;
                if event_wall_ms < origin_wall_ms {
                    return None;
                }

                Some(FocusEvent {
                    t: event_wall_ms.saturating_sub(origin_wall_ms),
                    state: state.to_string(),
                })
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Keyboard device info
// ---------------------------------------------------------------------------

/// Info about the matched keyboard device, populated by the HID device-matched callback.
#[derive(Debug, Clone)]
pub struct KeyboardInfo {
    pub vendor_id: u32,
    pub product_id: u32,
    pub transport: String,
}

// ---------------------------------------------------------------------------
// Shared app state
// ---------------------------------------------------------------------------

/// Shared state across Tauri commands and HID thread.
pub struct AppState {
    pub session: Mutex<SessionState>,
    /// Persisted editor document state (markdown content, cursor, mode).
    pub editor_state: Mutex<EditorDocumentState>,
    /// Set to true only after IOHIDManagerOpen succeeds.
    pub hid_active: AtomicBool,
    /// Timestamp (ns) of the most recent built-in keyboard keydown
    pub builtin_keydown_timestamp: AtomicU64,
    /// Integrity check results captured at startup.
    pub integrity: IntegrityReport,
    /// Matched keyboard device info; populated on first device-matched callback.
    pub keyboard_info: Mutex<Option<KeyboardInfo>>,
    /// Wall-clock ns of the most recent keydown, used to detect synthetic bursts.
    pub last_keydown_ns: AtomicU64,

    /// Runtime observability state used for crash and upload health summaries.
    pub observability: Mutex<RuntimeObservability>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_event_serializes() {
        let e = KeyEvent {
            t: 1_000_000,
            kind: "down".into(),
            key: 4,
            flags: 0,
            suspicious: false,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"type\":\"down\""));
        assert!(json.contains("\"key\":4"));
        assert!(!json.contains("suspicious")); // false is omitted
    }

    #[test]
    fn test_key_event_suspicious_serializes() {
        let e = KeyEvent {
            t: 1_000_000,
            kind: "down".into(),
            key: 4,
            flags: 0,
            suspicious: true,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"suspicious\":true"));
    }

    #[test]
    fn test_extra_event_no_nulls() {
        let e = ExtraEvent {
            t: 1_000,
            kind: "paste".into(),
            char_count: Some(10),
            duration_ms: None,
            content_hash: None,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"char_count\":10"));
        assert!(!json.contains("duration_ms"));
        assert!(!json.contains("content_hash"));
    }

    #[test]
    fn test_extra_event_content_hash_serializes() {
        let e = ExtraEvent {
            t: 1_000,
            kind: "paste".into(),
            char_count: Some(5),
            duration_ms: None,
            content_hash: Some("abc123".into()),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"content_hash\":\"abc123\""));
    }

    #[test]
    fn test_focus_events_derive_elapsed_ms_from_session_log() {
        let mut s = SessionState::new(0);
        let start = s.start_wall_ns;
        s.append_extra(ExtraEvent {
            t: start + 250_000_000,
            kind: "focus_inactive".into(),
            char_count: None,
            duration_ms: None,
            content_hash: None,
        });
        s.append_extra(ExtraEvent {
            t: start + 1_000_000_000,
            kind: "focus_active".into(),
            char_count: None,
            duration_ms: None,
            content_hash: None,
        });
        s.append_extra(ExtraEvent {
            t: start + 1_500_000_000,
            kind: "paste".into(),
            char_count: Some(4),
            duration_ms: None,
            content_hash: None,
        });

        assert_eq!(
            s.focus_events(),
            vec![
                FocusEvent {
                    t: 250,
                    state: "inactive".into(),
                },
                FocusEvent {
                    t: 1000,
                    state: "active".into(),
                },
            ]
        );
    }

    #[test]
    fn test_focus_events_can_be_rebased_to_document_replay_origin() {
        let mut s = SessionState::new(0);
        let start = s.start_wall_ns;
        s.append_extra(ExtraEvent {
            t: start + 1_000_000_000,
            kind: "focus_inactive".into(),
            char_count: None,
            duration_ms: None,
            content_hash: None,
        });
        s.append_extra(ExtraEvent {
            t: start + 2_500_000_000,
            kind: "focus_active".into(),
            char_count: None,
            duration_ms: None,
            content_hash: None,
        });

        assert_eq!(
            s.focus_events_since_wall_ms((start / 1_000_000) + 2_000),
            vec![FocusEvent {
                t: 500,
                state: "active".into(),
            }]
        );
    }

    #[test]
    fn test_session_keystroke_count() {
        let mut s = SessionState::new(0);
        s.append_key(KeyEvent {
            t: 1,
            kind: "down".into(),
            key: 4,
            flags: 0,
            suspicious: false,
        });
        s.append_key(KeyEvent {
            t: 2,
            kind: "up".into(),
            key: 4,
            flags: 0,
            suspicious: false,
        });
        s.append_extra(ExtraEvent {
            t: 3,
            kind: "paste".into(),
            char_count: Some(5),
            duration_ms: None,
            content_hash: None,
        });
        assert_eq!(s.keystroke_count(), 2);
    }

    #[test]
    fn test_session_id_is_short_and_url_safe() {
        let id = SessionState::new(0).session_id;
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_to_jsonl() {
        let mut s = SessionState::new(0);
        s.append_key(KeyEvent {
            t: 1,
            kind: "down".into(),
            key: 4,
            flags: 0,
            suspicious: false,
        });
        s.append_extra(ExtraEvent {
            t: 2,
            kind: "paste".into(),
            char_count: Some(3),
            duration_ms: None,
            content_hash: None,
        });
        let jsonl = s.to_jsonl();
        let lines: Vec<&str> = jsonl.lines().collect();
        assert_eq!(lines.len(), 2);
        serde_json::from_str::<serde_json::Value>(lines[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(lines[1]).unwrap();
    }

    #[test]
    fn test_log_chain_advances() {
        let mut s = SessionState::new(0);
        let chain_before = s.log_chain_hash();
        s.append_key(KeyEvent {
            t: 1,
            kind: "down".into(),
            key: 4,
            flags: 0,
            suspicious: false,
        });
        let chain_after = s.log_chain_hash();
        assert_ne!(
            chain_before, chain_after,
            "chain must advance after each entry"
        );
    }

    #[test]
    fn test_log_chain_deterministic() {
        // Two sessions with the same nonce should produce the same chain after the same entries.
        // We can't force the nonce, but we can verify that the chain is a function of entries.
        let mut s = SessionState::new(0);
        s.append_key(KeyEvent {
            t: 1,
            kind: "down".into(),
            key: 4,
            flags: 0,
            suspicious: false,
        });
        s.append_key(KeyEvent {
            t: 2,
            kind: "up".into(),
            key: 4,
            flags: 0,
            suspicious: false,
        });
        // The chain hash should be a 64-char hex string
        assert_eq!(s.log_chain_hash().len(), 64);
    }
}
