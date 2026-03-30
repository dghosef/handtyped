use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditorMode {
    Split,
    Source,
}

impl Default for EditorMode {
    fn default() -> Self {
        Self::Source
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EditorDocumentState {
    pub markdown: String,
    pub cursor: usize,
    #[serde(default)]
    pub mode: EditorMode,
}

fn editor_state_dir() -> PathBuf {
    let mut path = dirs_next::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    path.push("humanproof");
    path.push("editor");
    path
}

fn editor_state_path() -> PathBuf {
    let mut path = editor_state_dir();
    path.push("editor-state.json");
    path
}

pub fn load_editor_state_from_disk() -> Result<Option<EditorDocumentState>, String> {
    let path = editor_state_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let state = serde_json::from_str::<EditorDocumentState>(&raw).map_err(|e| e.to_string())?;
    Ok(Some(state))
}

pub fn save_editor_state_to_disk(state: &EditorDocumentState) -> Result<(), String> {
    let dir = editor_state_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(editor_state_path(), raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_mode_defaults_to_source() {
      let state = EditorDocumentState::default();
      assert_eq!(state.mode, EditorMode::Source);
      assert_eq!(state.cursor, 0);
      assert!(state.markdown.is_empty());
    }

    #[test]
    fn editor_state_round_trips_json() {
        let state = EditorDocumentState {
            markdown: "# Test\n\nBody".into(),
            cursor: 4,
            mode: EditorMode::Split,
        };

        let json = serde_json::to_string(&state).unwrap();
        let restored: EditorDocumentState = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.markdown, "# Test\n\nBody");
        assert_eq!(restored.cursor, 4);
        assert_eq!(restored.mode, EditorMode::Split);
    }
}
