use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::signing;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TextChange {
    pub pos: usize,
    pub del: String,
    pub ins: String,
    #[serde(default)]
    pub cursor_before: usize,
    #[serde(default)]
    pub cursor_after: usize,
}

impl TextChange {
    pub fn apply_to(&self, current: &str) -> String {
        let mut chars: Vec<char> = current.chars().collect();
        let pos = self.pos.min(chars.len());
        let delete_len = self.del.chars().count();
        let end = pos.saturating_add(delete_len).min(chars.len());
        chars.splice(pos..end, self.ins.chars());
        chars.into_iter().collect()
    }

    pub fn apply_inverse_to(&self, current: &str) -> String {
        let mut chars: Vec<char> = current.chars().collect();
        let pos = self.pos.min(chars.len());
        let insert_len = self.ins.chars().count();
        let end = pos.saturating_add(insert_len).min(chars.len());
        chars.splice(pos..end, self.del.chars());
        chars.into_iter().collect()
    }
}

pub fn build_text_change(previous: &str, next: &str) -> Option<TextChange> {
    build_text_change_with_cursors(previous, next, 0, 0)
}

pub fn build_text_change_with_cursors(
    previous: &str,
    next: &str,
    cursor_before: usize,
    cursor_after: usize,
) -> Option<TextChange> {
    if previous == next {
        return None;
    }

    let previous_chars: Vec<char> = previous.chars().collect();
    let next_chars: Vec<char> = next.chars().collect();

    let mut prefix = 0usize;
    while prefix < previous_chars.len()
        && prefix < next_chars.len()
        && previous_chars[prefix] == next_chars[prefix]
    {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix < previous_chars.len().saturating_sub(prefix)
        && suffix < next_chars.len().saturating_sub(prefix)
        && previous_chars[previous_chars.len() - 1 - suffix]
            == next_chars[next_chars.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let deleted: String = previous_chars[prefix..previous_chars.len().saturating_sub(suffix)]
        .iter()
        .collect();
    let inserted: String = next_chars[prefix..next_chars.len().saturating_sub(suffix)]
        .iter()
        .collect();

    Some(TextChange {
        pos: prefix,
        del: deleted,
        ins: inserted,
        cursor_before,
        cursor_after,
    })
}

pub fn changes_from_revisions(revisions: &[String]) -> Vec<TextChange> {
    revisions
        .windows(2)
        .filter_map(|pair| build_text_change(&pair[0], &pair[1]))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditorMode {
    Split,
    Source,
}

impl Default for EditorMode {
    fn default() -> Self {
        Self::Split
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EditorDocumentState {
    pub markdown: String,
    pub cursor: usize,
    #[serde(default)]
    pub mode: EditorMode,
    #[serde(default)]
    pub vim_enabled: bool,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub undo_changes: Vec<TextChange>,
    #[serde(default)]
    pub undo_index: usize,
    #[serde(default)]
    pub recent_files: Vec<PathBuf>,
    #[serde(
        default,
        rename = "undo_revisions",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub legacy_undo_revisions: Vec<String>,
}

fn editor_state_dir() -> PathBuf {
    let mut path = dirs_next::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    path.push("handtyped");
    path.push("editor");
    path
}

fn editor_state_path() -> PathBuf {
    let mut path = editor_state_dir();
    path.push("editor-state.json");
    path
}

fn load_editor_state_from_path(path: &Path) -> Result<Option<EditorDocumentState>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;

    // Backward-compatible: older signed envelopes still load.
    if let Ok(env) = serde_json::from_str::<SignedEditorDocEnvelopeV1>(&raw) {
        return Ok(Some(normalize_editor_state(env.payload)));
    }

    let state = serde_json::from_str::<EditorDocumentState>(&raw).map_err(|e| e.to_string())?;
    Ok(Some(normalize_editor_state(state)))
}

fn save_editor_state_to_path(path: &Path, state: &EditorDocumentState) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    // Editor UI state is convenience state, not a signed user document.
    // Keep it plaintext so launch/new-document flows never block on Keychain.
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SignedEditorDocEnvelopeV1 {
    version: u32,
    pubkey_hex: String,
    payload: EditorDocumentState,
    signature_hex: String, // 64-byte raw signature as hex
}

#[derive(Debug, Clone)]
pub struct EditorDocAuthStatus {
    pub signature_valid: bool,
    pub doc_pubkey: [u8; 32],
}

pub fn load_editor_state_from_disk() -> Result<Option<EditorDocumentState>, String> {
    load_editor_state_from_path(&editor_state_path())
}

pub fn save_editor_state_to_disk(state: &EditorDocumentState) -> Result<(), String> {
    save_editor_state_to_path(&editor_state_path(), state)
}

pub fn normalize_editor_state(mut state: EditorDocumentState) -> EditorDocumentState {
    if state.undo_changes.is_empty() && !state.legacy_undo_revisions.is_empty() {
        state.undo_changes = changes_from_revisions(&state.legacy_undo_revisions);
    }
    state.undo_index = state.undo_index.min(state.undo_changes.len());
    state.legacy_undo_revisions.clear();
    state
}

pub fn load_editor_doc_auth_status_from_disk() -> Result<Option<EditorDocAuthStatus>, String> {
    let path = editor_state_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let env = match serde_json::from_str::<SignedEditorDocEnvelopeV1>(&raw) {
        Ok(e) => e,
        Err(_) => return Ok(None), // legacy plaintext file → unknown auth status
    };

    let pubkey_bytes_vec = hex::decode(env.pubkey_hex).map_err(|e| e.to_string())?;
    if pubkey_bytes_vec.len() != 32 {
        return Ok(None);
    }
    let mut pubkey_bytes = [0u8; 32];
    pubkey_bytes.copy_from_slice(&pubkey_bytes_vec);

    let sig_bytes_vec = hex::decode(env.signature_hex).map_err(|e| e.to_string())?;
    if sig_bytes_vec.len() != 64 {
        return Ok(None);
    }
    let mut sig_bytes = [0u8; 64];
    sig_bytes.copy_from_slice(&sig_bytes_vec);

    let payload_bytes = serde_json::to_vec(&env.payload).map_err(|e| e.to_string())?;
    let signature_valid = signing::verify(&pubkey_bytes, &payload_bytes, &sig_bytes);

    Ok(Some(EditorDocAuthStatus {
        signature_valid,
        doc_pubkey: pubkey_bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn editor_mode_defaults_to_split() {
        let state = EditorDocumentState::default();
        assert_eq!(state.mode, EditorMode::Split);
        assert!(!state.vim_enabled);
        assert_eq!(state.cursor, 0);
        assert!(state.markdown.is_empty());
        assert!(state.undo_changes.is_empty());
        assert_eq!(state.undo_index, 0);
        assert!(state.recent_files.is_empty());
    }

    #[test]
    fn editor_state_round_trips_json() {
        let state = EditorDocumentState {
            markdown: "# Test\n\nBody".into(),
            cursor: 4,
            mode: EditorMode::Split,
            vim_enabled: true,
            theme: Some("nord".into()),
            undo_changes: vec![TextChange {
                pos: 0,
                del: String::new(),
                ins: "# Test\n\nBody".into(),
                cursor_before: 0,
                cursor_after: 0,
            }],
            undo_index: 0,
            recent_files: vec![
                PathBuf::from("/tmp/first.ht"),
                PathBuf::from("/tmp/second.ht"),
            ],
            legacy_undo_revisions: Vec::new(),
        };

        let json = serde_json::to_string(&state).unwrap();
        let restored: EditorDocumentState = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.markdown, "# Test\n\nBody");
        assert_eq!(restored.cursor, 4);
        assert_eq!(restored.mode, EditorMode::Split);
        assert!(restored.vim_enabled);
        assert_eq!(restored.theme.as_deref(), Some("nord"));
        assert_eq!(restored.undo_changes.len(), 1);
        assert_eq!(restored.undo_changes[0].ins, "# Test\n\nBody");
        assert_eq!(restored.undo_index, 0);
        assert_eq!(restored.recent_files.len(), 2);
    }

    #[test]
    fn editor_state_disk_save_stays_plaintext_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("editor-state.json");
        let state = EditorDocumentState {
            markdown: "# Test\n\nBody".into(),
            cursor: 4,
            mode: EditorMode::Split,
            vim_enabled: true,
            theme: Some("gruvbox".into()),
            undo_changes: vec![TextChange {
                pos: 0,
                del: String::new(),
                ins: "# Test\n\nBody".into(),
                cursor_before: 0,
                cursor_after: 0,
            }],
            undo_index: 0,
            recent_files: vec![PathBuf::from("/tmp/document.htd")],
            legacy_undo_revisions: Vec::new(),
        };

        save_editor_state_to_path(&path, &state).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(serde_json::from_str::<SignedEditorDocEnvelopeV1>(&raw).is_err());

        let restored = load_editor_state_from_path(&path).unwrap().unwrap();
        assert_eq!(restored.markdown, state.markdown);
        assert_eq!(restored.mode, state.mode);
        assert_eq!(restored.vim_enabled, state.vim_enabled);
        assert_eq!(restored.undo_changes, state.undo_changes);
        assert_eq!(restored.recent_files, state.recent_files);
    }

    #[test]
    fn load_editor_state_still_supports_legacy_signed_envelopes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("editor-state.json");
        let state = EditorDocumentState {
            markdown: "legacy".into(),
            cursor: 1,
            mode: EditorMode::Source,
            vim_enabled: true,
            theme: Some("nord".into()),
            undo_changes: Vec::new(),
            undo_index: 0,
            recent_files: vec![PathBuf::from("/tmp/legacy.htd")],
            legacy_undo_revisions: Vec::new(),
        };

        let env = SignedEditorDocEnvelopeV1 {
            version: 1,
            pubkey_hex: "00".repeat(32),
            payload: state.clone(),
            signature_hex: "00".repeat(64),
        };

        fs::write(&path, serde_json::to_string_pretty(&env).unwrap()).unwrap();

        let restored = load_editor_state_from_path(&path).unwrap().unwrap();
        assert_eq!(restored.markdown, state.markdown);
        assert_eq!(restored.mode, state.mode);
        assert_eq!(restored.vim_enabled, state.vim_enabled);
        assert_eq!(restored.recent_files, state.recent_files);
        assert!(restored.undo_changes.is_empty());
    }

    #[test]
    fn normalize_editor_state_converts_legacy_undo_revisions() {
        let state = EditorDocumentState {
            markdown: "third".into(),
            cursor: 0,
            mode: EditorMode::Source,
            vim_enabled: false,
            theme: None,
            undo_changes: Vec::new(),
            undo_index: 2,
            recent_files: Vec::new(),
            legacy_undo_revisions: vec!["first".into(), "second".into(), "third".into()],
        };

        let normalized = normalize_editor_state(state);
        assert_eq!(normalized.undo_index, 2);
        assert_eq!(normalized.undo_changes.len(), 2);
        assert_eq!(
            normalized.undo_changes[0],
            TextChange {
                pos: 0,
                del: "first".into(),
                ins: "second".into(),
                cursor_before: 0,
                cursor_after: 0,
            }
        );
        assert_eq!(
            normalized.undo_changes[1],
            TextChange {
                pos: 0,
                del: "secon".into(),
                ins: "thir".into(),
                cursor_before: 0,
                cursor_after: 0,
            }
        );
    }

    #[test]
    fn text_change_round_trips_forward_and_inverse() {
        let change = build_text_change("hello world", "hello rust").unwrap();
        assert_eq!(change.pos, 6);
        assert_eq!(change.del, "world");
        assert_eq!(change.ins, "rust");
        assert_eq!(change.apply_to("hello world"), "hello rust");
        assert_eq!(change.apply_inverse_to("hello rust"), "hello world");
    }

    #[test]
    fn text_change_handles_insert_at_start() {
        let change = build_text_change("world", "hello world").unwrap();
        assert_eq!(change.pos, 0);
        assert_eq!(change.del, "");
        assert_eq!(change.ins, "hello ");
        assert_eq!(change.apply_to("world"), "hello world");
        assert_eq!(change.apply_inverse_to("hello world"), "world");
    }

    #[test]
    fn text_change_handles_insert_at_end() {
        let change = build_text_change("hello", "hello world").unwrap();
        assert_eq!(change.pos, 5);
        assert_eq!(change.del, "");
        assert_eq!(change.ins, " world");
        assert_eq!(change.apply_to("hello"), "hello world");
        assert_eq!(change.apply_inverse_to("hello world"), "hello");
    }

    #[test]
    fn text_change_handles_full_replacement() {
        let change = build_text_change("alpha", "beta").unwrap();
        assert_eq!(change.pos, 0);
        assert_eq!(change.del, "alph");
        assert_eq!(change.ins, "bet");
        assert_eq!(change.apply_to("alpha"), "beta");
        assert_eq!(change.apply_inverse_to("beta"), "alpha");
    }

    #[test]
    fn text_change_handles_deletion_only() {
        let change = build_text_change("hello world", "hello ").unwrap();
        assert_eq!(change.pos, 6);
        assert_eq!(change.del, "world");
        assert_eq!(change.ins, "");
        assert_eq!(change.apply_to("hello world"), "hello ");
        assert_eq!(change.apply_inverse_to("hello "), "hello world");
    }

    #[test]
    fn text_change_handles_unicode_graphemeish_sequences() {
        let change = build_text_change("hi 😀 there", "hi 😎 there").unwrap();
        assert_eq!(change.pos, 3);
        assert_eq!(change.del, "😀");
        assert_eq!(change.ins, "😎");
        assert_eq!(change.apply_to("hi 😀 there"), "hi 😎 there");
        assert_eq!(change.apply_inverse_to("hi 😎 there"), "hi 😀 there");
    }

    #[test]
    fn text_change_handles_multiline_replacement() {
        let change = build_text_change("a\nb\nc", "a\nx\nc").unwrap();
        assert_eq!(change.pos, 2);
        assert_eq!(change.del, "b");
        assert_eq!(change.ins, "x");
        assert_eq!(change.apply_to("a\nb\nc"), "a\nx\nc");
        assert_eq!(change.apply_inverse_to("a\nx\nc"), "a\nb\nc");
    }

    #[test]
    fn changes_from_revisions_reconstructs_final_revision() {
        let revisions = vec![
            "".to_string(),
            "a".to_string(),
            "ab".to_string(),
            "ax".to_string(),
            "ax\nz".to_string(),
        ];
        let changes = changes_from_revisions(&revisions);
        let rebuilt = changes
            .iter()
            .fold(revisions[0].clone(), |current, change| {
                change.apply_to(&current)
            });

        assert_eq!(rebuilt, revisions.last().unwrap().to_string());
    }

    #[test]
    fn changes_from_revisions_reconstructs_every_intermediate_revision() {
        let revisions = vec![
            "".to_string(),
            "a".to_string(),
            "ab".to_string(),
            "aβ".to_string(),
            "aβ\nz".to_string(),
            "β\nz".to_string(),
        ];
        let changes = changes_from_revisions(&revisions);
        let mut current = revisions[0].clone();

        for (change, expected) in changes.iter().zip(revisions.iter().skip(1)) {
            current = change.apply_to(&current);
            assert_eq!(&current, expected);
        }
    }

    #[test]
    fn inverse_changes_restore_previous_revision_sequence() {
        let revisions = vec![
            "".to_string(),
            "hello".to_string(),
            "hello world".to_string(),
            "hello\nworld".to_string(),
        ];
        let changes = changes_from_revisions(&revisions);
        let final_text = revisions.last().cloned().unwrap();

        let restored = changes.iter().rev().fold(final_text, |current, change| {
            change.apply_inverse_to(&current)
        });

        assert_eq!(restored, revisions[0]);
    }

    #[test]
    fn normalize_editor_state_clamps_undo_index_after_legacy_conversion() {
        let state = EditorDocumentState {
            markdown: "third".into(),
            cursor: 0,
            mode: EditorMode::Split,
            vim_enabled: false,
            theme: None,
            undo_changes: Vec::new(),
            undo_index: 99,
            recent_files: Vec::new(),
            legacy_undo_revisions: vec!["first".into(), "second".into(), "third".into()],
        };

        let normalized = normalize_editor_state(state);
        assert_eq!(normalized.undo_changes.len(), 2);
        assert_eq!(normalized.undo_index, 2);
    }

    #[test]
    fn text_change_handles_inserting_newline_in_middle() {
        let change = build_text_change("hello world", "hello\nworld").unwrap();
        assert_eq!(change.pos, 5);
        assert_eq!(change.del, " ");
        assert_eq!(change.ins, "\n");
        assert_eq!(change.apply_to("hello world"), "hello\nworld");
        assert_eq!(change.apply_inverse_to("hello\nworld"), "hello world");
    }
}
