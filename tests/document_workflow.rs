//! Integration tests for the Handtyped document workflow.
//!
//! These tests verify end-to-end multi-session workflows including:
//! - Multi-edit undo/redo persistence across saves
//! - Session continuity (nonce + created_at preserved)
//! - Signature rejection on tampered files

use handtyped_lib::document::{self, DocumentPayload};
use handtyped_lib::editor::{EditorMode, TextChange};
use std::fs;
use tempfile::TempDir;

// ============================================================================
// Multi-edit workflow: undo history accumulates across saves
// ============================================================================

fn tc(pos: usize, del: &str, ins: &str) -> TextChange {
    TextChange {
        pos,
        del: del.to_string(),
        ins: ins.to_string(),
        cursor_before: 0,
        cursor_after: 0,
    }
}

#[test]
fn test_edit_document_preserves_history() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("edit.ht");

    // Version 1.
    let payload = document::new_document_payload("v1".to_string());
    let nonce = payload.session_nonce.clone();
    let created_at = payload.created_at.clone();
    document::save_document(&path, payload).unwrap();

    // Version 2 - simulate edit.
    let mut payload2 = document::new_document_payload("v2".to_string());
    payload2.session_nonce = nonce.clone();
    payload2.created_at = created_at.clone();
    payload2.undo_changes = vec![tc(1, "1", "2")];
    payload2.undo_index = 1;
    document::save_document(&path, payload2).unwrap();

    // Version 3 - another edit.
    let mut payload3 = document::new_document_payload("v3".to_string());
    payload3.session_nonce = nonce.clone();
    payload3.created_at = created_at.clone();
    payload3.undo_changes = vec![tc(1, "1", "2"), tc(1, "2", "3")];
    payload3.undo_index = 2;
    document::save_document(&path, payload3).unwrap();

    let loaded = document::load_document(&path).unwrap().unwrap();
    assert_eq!(loaded.payload.markdown, "v3");
    assert_eq!(loaded.payload.undo_changes.len(), 2);
    assert_eq!(loaded.payload.undo_index, 2);
    assert_eq!(loaded.payload.session_nonce, nonce);
    assert_eq!(loaded.payload.created_at, created_at);
}

// ============================================================================
// Undo/Redo persistence
// ============================================================================

#[test]
fn test_undo_persistence_single_session() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("undo.ht");

    let mut payload = document::new_document_payload("second edit".to_string());
    payload.undo_changes = vec![
        tc(0, "initial", "first edit"),
        tc(0, "first edit", "second edit"),
    ];
    payload.undo_index = 2;
    document::save_document(&path, payload).unwrap();

    let loaded = document::load_document(&path).unwrap().unwrap();
    assert_eq!(loaded.payload.undo_changes.len(), 2);
    assert_eq!(loaded.payload.undo_index, 2);
    assert_eq!(loaded.payload.markdown, "second edit");
    assert_eq!(loaded.payload.undo_changes[0], tc(0, "initial", "first edit"));
    assert_eq!(loaded.payload.undo_changes[1], tc(0, "first edit", "second edit"));
}

#[test]
fn test_undo_persistence_multiple_sessions() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("multi.ht");

    // Session 1.
    let mut payload1 = document::new_document_payload("start".to_string());
    payload1.undo_changes = vec![tc(0, "start", "edit1")];
    payload1.undo_index = 1;
    document::save_document(&path, payload1).unwrap();

    // Session 2: load, edit more, save.
    let existing = document::load_document(&path).unwrap().unwrap();
    let mut payload2 = document::new_document_payload("edit2".to_string());
    payload2.session_nonce = existing.payload.session_nonce;
    payload2.created_at = existing.payload.created_at;
    payload2.undo_changes = vec![tc(0, "start", "edit1"), tc(4, "1", "2")];
    payload2.undo_index = 2;
    document::save_document(&path, payload2).unwrap();

    // Session 3: load and verify full history.
    let loaded = document::load_document(&path).unwrap().unwrap();
    assert_eq!(loaded.payload.undo_changes.len(), 2);
    assert_eq!(loaded.payload.undo_index, 2);
    assert_eq!(loaded.payload.markdown, "edit2");
    assert_eq!(loaded.payload.undo_changes[0], tc(0, "start", "edit1"));
}

#[test]
fn test_redo_persistence() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("redo.ht");

    // Simulate state after an undo: cursor is at index 1 ("middle"),
    // with "final" still available as a redo target at index 2.
    let mut payload = document::new_document_payload("middle".to_string());
    payload.undo_changes = vec![tc(0, "initial", "middle"), tc(0, "middle", "final")];
    payload.undo_index = 1;
    document::save_document(&path, payload).unwrap();

    let loaded = document::load_document(&path).unwrap().unwrap();
    // Current state is "middle" (undo_revisions[undo_index]).
    assert_eq!(loaded.payload.undo_index, 1);
    assert_eq!(loaded.payload.markdown, "middle");
    // Redo is possible: there is a future revision.
    assert!(loaded.payload.undo_index < loaded.payload.undo_changes.len());
    assert_eq!(loaded.payload.undo_changes[1], tc(0, "middle", "final"));
}

// ============================================================================
// Tamper detection (distinct from unit tests: goes through full disk I/O path)
// ============================================================================

#[test]
fn test_tampered_content_rejected_on_load() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("tampered.ht");

    let payload = document::new_document_payload("original".to_string());
    document::save_document(&path, payload).unwrap();

    let json = fs::read_to_string(&path).unwrap();
    let mut doc: serde_json::Value = serde_json::from_str(&json).unwrap();
    doc["payload"]["markdown"] = serde_json::json!("tampered");
    fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();

    let result = document::load_document(&path);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("verification failed"));
}

#[test]
fn test_corrupted_signature_rejected_on_load() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("badsig.ht");

    let payload = document::new_document_payload("content".to_string());
    document::save_document(&path, payload).unwrap();

    let json = fs::read_to_string(&path).unwrap();
    let mut doc: serde_json::Value = serde_json::from_str(&json).unwrap();
    doc["signature_hex"] = serde_json::json!("00".repeat(64));
    fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();

    let result = document::load_document(&path);
    assert!(result.is_err());
}

// ============================================================================
// Multi-document independence and rapid cycles
// ============================================================================

#[test]
fn test_multiple_documents_independent() {
    let temp_dir = TempDir::new().unwrap();

    let path_a = temp_dir.path().join("doc_a.ht");
    let payload_a = document::new_document_payload("Document A".to_string());
    document::save_document(&path_a, payload_a).unwrap();

    let path_b = temp_dir.path().join("doc_b.ht");
    let payload_b = document::new_document_payload("Document B".to_string());
    document::save_document(&path_b, payload_b).unwrap();

    let loaded_a = document::load_document(&path_a).unwrap().unwrap();
    let loaded_b = document::load_document(&path_b).unwrap().unwrap();

    assert_eq!(loaded_a.payload.markdown, "Document A");
    assert_eq!(loaded_b.payload.markdown, "Document B");
    assert_ne!(
        loaded_a.payload.session_nonce,
        loaded_b.payload.session_nonce
    );
}

#[test]
fn test_rapid_save_load_cycle() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("rapid.ht");

    for i in 0..10 {
        let mut payload = document::new_document_payload(format!("version {}", i));
        if i > 0 {
            let existing = document::load_document(&path).unwrap().unwrap();
            payload.session_nonce = existing.payload.session_nonce;
            payload.created_at = existing.payload.created_at;
        }
        document::save_document(&path, payload).unwrap();
    }

    let loaded = document::load_document(&path).unwrap().unwrap();
    assert_eq!(loaded.payload.markdown, "version 9");
}

// ============================================================================
// Session continuity
// ============================================================================

#[test]
fn test_session_nonce_uniqueness() {
    let nonces: Vec<_> = (0..100)
        .map(|_| document::new_document_payload("test".to_string()).session_nonce)
        .collect();

    let unique_count = nonces
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len();
    assert_eq!(unique_count, 100);
}

#[test]
fn test_timestamps_increase_on_edit() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("timestamps.ht");

    let payload1 = document::new_document_payload("v1".to_string());
    let created1 = payload1.created_at.clone();
    document::save_document(&path, payload1).unwrap();

    std::thread::sleep(std::time::Duration::from_millis(10));

    let mut payload2 = document::new_document_payload("v2".to_string());
    payload2.created_at = created1.clone();
    document::save_document(&path, payload2).unwrap();

    let loaded = document::load_document(&path).unwrap().unwrap();
    assert_eq!(loaded.payload.created_at, created1);
    assert!(loaded.payload.modified_at >= loaded.payload.created_at);
}

#[test]
fn test_session_continuity_across_restarts() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("restart.ht");

    // "Session 1" - create.
    let payload1 = document::new_document_payload("start".to_string());
    let session_nonce = payload1.session_nonce.clone();
    let created_at = payload1.created_at.clone();
    document::save_document(&path, payload1).unwrap();

    // "Session 2" - load, edit, save.
    let existing = document::load_document(&path).unwrap().unwrap();
    assert_eq!(existing.payload.session_nonce, session_nonce);

    let mut payload2 = document::new_document_payload("after restart".to_string());
    payload2.session_nonce = existing.payload.session_nonce;
    payload2.created_at = existing.payload.created_at;
    payload2.undo_changes = vec![tc(0, &existing.payload.markdown, "after restart")];
    payload2.undo_index = 1;
    document::save_document(&path, payload2).unwrap();

    // "Session 3" - verify continuity.
    let final_doc = document::load_document(&path).unwrap().unwrap();
    assert_eq!(final_doc.payload.session_nonce, session_nonce);
    assert_eq!(final_doc.payload.created_at, created_at);
    assert_eq!(final_doc.payload.undo_changes.len(), 1);
}

#[test]
fn test_save_as_preserves_source_history_and_new_content() {
    let temp_dir = TempDir::new().unwrap();
    let source_path = temp_dir.path().join("source.ht");
    let new_path = temp_dir.path().join("copy.ht");

    let mut original = document::new_document_payload("v1".to_string());
    original.undo_changes = vec![tc(1, "0", "1")];
    original.undo_index = 1;
    let original_nonce = original.session_nonce.clone();
    let original_created_at = original.created_at.clone();
    document::save_document(&source_path, original).unwrap();

    let source = document::load_document(&source_path).unwrap().unwrap();
    let mut save_as_payload = document::new_document_payload("v2".to_string());
    save_as_payload.session_nonce = source.payload.session_nonce.clone();
    save_as_payload.created_at = source.payload.created_at.clone();
    save_as_payload.undo_changes = vec![tc(1, "0", "1"), tc(1, "1", "2")];
    save_as_payload.undo_index = 2;
    document::save_document(&new_path, save_as_payload).unwrap();

    let new_doc = document::load_document(&new_path).unwrap().unwrap();
    assert_eq!(new_doc.payload.markdown, "v2");
    assert_eq!(new_doc.payload.session_nonce, original_nonce);
    assert_eq!(new_doc.payload.created_at, original_created_at);
    assert_eq!(
        new_doc.payload.undo_changes,
        vec![tc(1, "0", "1"), tc(1, "1", "2")]
    );
    assert_eq!(new_doc.payload.undo_index, 2);
}

// ============================================================================
// Full payload round-trip
// ============================================================================

#[test]
fn test_document_with_all_fields() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("complete.ht");

    let payload = DocumentPayload {
        markdown: "# Complete Document\n\nWith **all** fields.".to_string(),
        cursor: 42,
        mode: EditorMode::Split,
        theme: Some("nord".to_string()),
        undo_changes: vec![tc(1, "1", "2"), tc(1, "2", "3")],
        undo_index: 2,
        session_keystrokes: Vec::new(),
        doc_history: vec![
            serde_json::json!({ "t": 0_u64, "pos": 0_usize, "del": "", "ins": "# Complete Document\n\nWith **all** fields." }),
        ],
        session_nonce: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        modified_at: chrono::Utc::now().to_rfc3339(),
        legacy_undo_revisions: Vec::new(),
    };

    document::save_document(&path, payload.clone()).unwrap();
    let loaded = document::load_document(&path).unwrap().unwrap();

    assert_eq!(loaded.payload.markdown, payload.markdown);
    assert_eq!(loaded.payload.cursor, payload.cursor);
    assert_eq!(loaded.payload.mode, payload.mode);
    assert_eq!(loaded.payload.theme, payload.theme);
    assert_eq!(loaded.payload.undo_changes, payload.undo_changes);
    assert_eq!(loaded.payload.undo_index, payload.undo_index);
}
