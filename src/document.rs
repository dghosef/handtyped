//! Signed `.ht` document container format.
//!
//! Format structure (JSON with signature):
//! ```json
//! {
//!   "version": 1,
//!   "format": "handtyped-signed-doc-v1",
//!   "payload": {
//!     "markdown": "...",
//!     "cursor": 0,
//!     "theme": "gruvbox",
//!     "undo_revisions": [...],
//!     "undo_index": 0,
//!     "session_keystrokes": [...],
//!     "created_at": "...",
//!     "modified_at": "..."
//!   },
//!   "signature_hex": "<64-byte ed25519 signature>"
//! }
//! ```
//!
//! The signature covers the canonical JSON serialization of `payload`.
//! This ensures the document can only be modified by Handtyped.

use chrono::Utc;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::editor::{changes_from_revisions, EditorMode, TextChange};
use crate::session::KeyEvent;
use crate::signing;

/// Preferred file extension for Handtyped documents.
pub const DOCUMENT_EXTENSION: &str = "ht";
/// File extensions the app should still recognize for backwards compatibility.
pub const DOCUMENT_OPEN_EXTENSIONS: &[&str] = &[DOCUMENT_EXTENSION, "htd", "tw"];

/// Current `.ht` file format version.
const FORMAT_VERSION: u32 = 1;
const FORMAT_MARKER: &str = "handtyped-signed-doc-v1";
const LEGACY_FORMAT_MARKER: &str = "typewriter-signed-doc-v1";

/// A signed Handtyped document container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedDocument {
    /// Format version for future compatibility.
    pub version: u32,
    /// Format marker string.
    pub format: String,
    /// The actual document content and metadata.
    pub payload: DocumentPayload,
    /// Hex-encoded ed25519 signature over canonical JSON of payload.
    pub signature_hex: String,
}

/// The payload that gets signed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentPayload {
    /// The markdown content.
    pub markdown: String,
    /// Cursor position (byte offset).
    pub cursor: usize,
    /// Editor mode (split or source-only).
    #[serde(default)]
    pub mode: EditorMode,
    /// Theme name.
    #[serde(default)]
    pub theme: Option<String>,
    /// Persistent undo history - list of compact edit operations.
    #[serde(default)]
    pub undo_changes: Vec<TextChange>,
    /// Current position in undo history.
    #[serde(default)]
    pub undo_index: usize,
    /// Keystroke events from the session (for replay continuity).
    #[serde(default)]
    pub session_keystrokes: Vec<KeyEvent>,
    /// Replay history snapshots across the lifetime of the file.
    #[serde(default)]
    pub doc_history: Vec<serde_json::Value>,
    /// Session nonce (32 random bytes, hex-encoded).
    #[serde(default)]
    pub session_nonce: String,
    /// Document creation timestamp.
    pub created_at: String,
    /// Last modification timestamp.
    pub modified_at: String,
    /// Legacy snapshot-based undo history accepted on load for backwards compatibility.
    #[serde(
        default,
        rename = "undo_revisions",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub legacy_undo_revisions: Vec<String>,
}

impl SignedDocument {
    /// Create a new signed document from a payload and signing key.
    pub fn new(payload: DocumentPayload, key: &SigningKey) -> Self {
        let payload_bytes = Self::canonical_payload(&payload);
        let sig = key.sign(&payload_bytes);
        Self {
            version: FORMAT_VERSION,
            format: FORMAT_MARKER.to_string(),
            payload,
            signature_hex: hex::encode(sig.to_bytes()),
        }
    }

    /// Serialize payload to canonical JSON bytes for signing/verification.
    fn canonical_payload(payload: &DocumentPayload) -> Vec<u8> {
        // Use compact JSON (no whitespace) for deterministic serialization.
        serde_json::to_vec(payload).unwrap_or_else(|_| Vec::new())
    }

    /// Verify the document's signature against a public key.
    pub fn verify(&self, pubkey: &VerifyingKey) -> bool {
        let payload_bytes = Self::canonical_payload(&self.payload);
        let sig_bytes = match hex::decode(&self.signature_hex) {
            Ok(b) if b.len() == 64 => {
                let mut arr = [0u8; 64];
                arr.copy_from_slice(&b);
                arr
            }
            _ => return false,
        };
        pubkey
            .verify(
                &payload_bytes,
                &ed25519_dalek::Signature::from_bytes(&sig_bytes),
            )
            .is_ok()
    }

    /// Compute SHA-256 hash of the document content (for quick integrity checks).
    pub fn content_hash(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.payload.markdown.as_bytes());
        hex::encode(h.finalize())
    }
}

/// Get the directory where Handtyped documents are stored by default.
pub fn documents_dir() -> PathBuf {
    let mut path = dirs_next::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    path.push("handtyped");
    path.push("documents");
    path
}

/// Ensure the documents directory exists.
pub fn ensure_documents_dir() -> Result<(), String> {
    let dir = documents_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

/// Save a document to disk as a signed `.ht` file.
pub fn save_document(path: &Path, payload: DocumentPayload) -> Result<(), String> {
    let key = signing::load_or_create_key()?;
    let doc = SignedDocument::new(payload, &key);
    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Load and verify a `.ht` document from disk.
/// Returns `Ok(Some(doc))` if the file exists and signature is valid.
/// Returns `Ok(None)` if the file doesn't exist.
/// Returns `Err` if the file exists but is corrupted or has invalid signature.
pub fn load_document(path: &Path) -> Result<Option<SignedDocument>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;

    // Try to parse as signed document.
    let doc: SignedDocument =
        serde_json::from_str(&json).map_err(|e| format!("Invalid document format: {}", e))?;

    // Verify format marker.
    if doc.format != FORMAT_MARKER && doc.format != LEGACY_FORMAT_MARKER {
        return Err(format!(
            "Unknown document format: {}. Expected {} or {}.",
            doc.format, FORMAT_MARKER, LEGACY_FORMAT_MARKER
        ));
    }

    // Verify signature against local keychain pubkey.
    let local_pubkey = signing::load_or_create_key()
        .map(|k| k.verifying_key())
        .map_err(|e| format!("Failed to load local key: {}", e))?;

    if !doc.verify(&local_pubkey) {
        return Err(
            "Document signature verification failed. File may have been tampered with.".to_string(),
        );
    }

    Ok(Some(normalize_signed_document(doc)))
}

/// Load a document without verification (for recovery/debugging).
/// Use with caution - the document may have been modified externally.
pub fn load_document_unverified(path: &Path) -> Result<Option<SignedDocument>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let doc: SignedDocument =
        serde_json::from_str(&json).map_err(|e| format!("Invalid document format: {}", e))?;

    Ok(Some(normalize_signed_document(doc)))
}

/// Create a new document payload with default values.
pub fn new_document_payload(markdown: String) -> DocumentPayload {
    let now = Utc::now().to_rfc3339();
    DocumentPayload {
        markdown: markdown.clone(),
        cursor: 0,
        mode: EditorMode::Source,
        theme: None,
        undo_changes: Vec::new(),
        undo_index: 0,
        session_keystrokes: Vec::new(),
        doc_history: if markdown.is_empty() {
            Vec::new()
        } else {
            vec![serde_json::json!({
                "t": 0_u64,
                "pos": 0_usize,
                "del": "",
                "ins": markdown,
            })]
        },
        session_nonce: uuid::Uuid::new_v4().to_string(),
        created_at: now.clone(),
        modified_at: now,
        legacy_undo_revisions: Vec::new(),
    }
}

/// Update the modification timestamp on a payload.
pub fn touch_payload(payload: &mut DocumentPayload) {
    payload.modified_at = Utc::now().to_rfc3339();
}

fn normalize_payload(mut payload: DocumentPayload) -> DocumentPayload {
    if payload.undo_changes.is_empty() && !payload.legacy_undo_revisions.is_empty() {
        payload.undo_changes = changes_from_revisions(&payload.legacy_undo_revisions);
    }
    payload.undo_index = payload.undo_index.min(payload.undo_changes.len());
    payload.legacy_undo_revisions.clear();
    payload
}

fn normalize_signed_document(mut doc: SignedDocument) -> SignedDocument {
    doc.payload = normalize_payload(doc.payload);
    doc
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;
    use std::fs;
    use tempfile::TempDir;

    fn test_key() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    // ========================================================================
    // Basic Document Creation Tests
    // ========================================================================

    #[test]
    fn test_new_document_has_valid_signature() {
        let key = test_key();
        let payload = new_document_payload("# Hello".to_string());
        let doc = SignedDocument::new(payload.clone(), &key);

        assert!(doc.verify(&key.verifying_key()));
        assert_eq!(doc.version, FORMAT_VERSION);
        assert_eq!(doc.format, FORMAT_MARKER);
    }

    #[test]
    fn test_document_payload_has_required_fields() {
        let markdown = "# Test Document\n\nSome content here.".to_string();
        let payload = new_document_payload(markdown.clone());

        assert_eq!(payload.markdown, markdown);
        assert_eq!(payload.cursor, 0);
        assert_eq!(payload.mode, EditorMode::Source);
        assert!(payload.theme.is_none());
        assert!(payload.undo_changes.is_empty());
        assert_eq!(payload.undo_index, 0);
        assert!(payload.session_keystrokes.is_empty());
        assert_eq!(payload.doc_history.len(), 1);
        assert_eq!(payload.doc_history[0]["pos"], 0);
        assert_eq!(payload.doc_history[0]["del"], "");
        assert_eq!(payload.doc_history[0]["ins"], payload.markdown);
        assert!(!payload.session_nonce.is_empty());
        assert!(!payload.created_at.is_empty());
        assert!(!payload.modified_at.is_empty());
        assert_eq!(payload.created_at, payload.modified_at);
    }

    #[test]
    fn test_document_round_trips_json() {
        let key = test_key();
        let payload = new_document_payload("# Test\n\nContent".to_string());
        let doc = SignedDocument::new(payload, &key);

        let json = serde_json::to_string(&doc).unwrap();
        let restored: SignedDocument = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.payload.markdown, "# Test\n\nContent");
        assert_eq!(restored.version, doc.version);
        assert_eq!(restored.format, doc.format);
        assert_eq!(restored.signature_hex, doc.signature_hex);
    }

    #[test]
    fn test_content_hash_is_deterministic() {
        let key = test_key();
        let payload = new_document_payload("Same content".to_string());
        let doc1 = SignedDocument::new(payload.clone(), &key);
        let doc2 = SignedDocument::new(payload, &key);

        assert_eq!(doc1.content_hash(), doc2.content_hash());
    }

    #[test]
    fn test_content_hash_changes_with_markdown() {
        let key = test_key();
        let payload1 = new_document_payload("Content A".to_string());
        let payload2 = new_document_payload("Content B".to_string());
        let doc1 = SignedDocument::new(payload1, &key);
        let doc2 = SignedDocument::new(payload2, &key);

        assert_ne!(doc1.content_hash(), doc2.content_hash());
    }

    // ========================================================================
    // Signature Verification Tests
    // ========================================================================

    #[test]
    fn test_tampered_content_fails_verification() {
        let key = test_key();
        let payload = new_document_payload("# Hello".to_string());
        let mut doc = SignedDocument::new(payload.clone(), &key);

        // Tamper with the content after signing.
        doc.payload.markdown = "# Tampered Content".to_string();

        assert!(!doc.verify(&key.verifying_key()));
    }

    #[test]
    fn test_tampered_cursor_fails_verification() {
        let key = test_key();
        let payload = new_document_payload("# Hello".to_string());
        let mut doc = SignedDocument::new(payload.clone(), &key);

        // Tamper with cursor position.
        doc.payload.cursor = 999;

        assert!(!doc.verify(&key.verifying_key()));
    }

    #[test]
    fn test_tampered_undo_history_fails_verification() {
        let key = test_key();
        let payload = new_document_payload("# Hello".to_string());
        let mut doc = SignedDocument::new(payload.clone(), &key);

        // Tamper with undo history.
        doc.payload.undo_changes.push(TextChange {
            pos: 0,
            del: String::new(),
            ins: "# Tampered".to_string(),
            cursor_before: 0,
            cursor_after: 0,
        });

        assert!(!doc.verify(&key.verifying_key()));
    }

    #[test]
    fn test_tampered_signature_fails_verification() {
        let key = test_key();
        let payload = new_document_payload("# Hello".to_string());
        let mut doc = SignedDocument::new(payload, &key);

        // Corrupt the signature.
        doc.signature_hex = "00".repeat(64);

        assert!(!doc.verify(&key.verifying_key()));
    }

    #[test]
    fn test_wrong_key_fails_verification() {
        let key1 = test_key();
        let key2 = test_key();
        let payload = new_document_payload("# Hello".to_string());
        let doc = SignedDocument::new(payload, &key1);

        // Verify with a different key.
        assert!(!doc.verify(&key2.verifying_key()));
    }

    #[test]
    fn test_empty_document_signs_correctly() {
        let key = test_key();
        let payload = new_document_payload("".to_string());
        let doc = SignedDocument::new(payload, &key);

        assert!(doc.verify(&key.verifying_key()));
    }

    #[test]
    fn test_large_document_signs_correctly() {
        let key = test_key();
        let large_markdown = "# Large Document\n\n".to_string() + &"Lorem ipsum. ".repeat(10000);
        let payload = new_document_payload(large_markdown.clone());
        let doc = SignedDocument::new(payload, &key);

        assert!(doc.verify(&key.verifying_key()));
        assert_eq!(doc.payload.markdown, large_markdown);
    }

    #[test]
    fn test_unicode_content_signs_correctly() {
        let key = test_key();
        let unicode_markdown = "# 你好世界\n\nこんにちは世界\n\n🚀🎉✨".to_string();
        let payload = new_document_payload(unicode_markdown.clone());
        let doc = SignedDocument::new(payload, &key);

        assert!(doc.verify(&key.verifying_key()));
        assert_eq!(doc.payload.markdown, unicode_markdown);
    }

    #[test]
    fn test_invalid_format_marker_fails_load() {
        let key = test_key();
        let payload = new_document_payload("# Test".to_string());
        let mut doc = SignedDocument::new(payload, &key);

        // Change the format marker.
        doc.format = "invalid-format-v1".to_string();

        let json = serde_json::to_string(&doc).unwrap();
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.ht");
        fs::write(&path, json).unwrap();

        let result = load_document(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown document format"));
    }

    // ========================================================================
    // Disk I/O Tests
    // ========================================================================

    #[test]
    fn test_save_and_load_document_roundtrip() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.ht");

        let original_payload = new_document_payload("# Test Document".to_string());
        save_document(&path, original_payload.clone()).unwrap();

        let loaded = load_document(&path).unwrap().unwrap();

        assert_eq!(loaded.payload.markdown, original_payload.markdown);
        assert_eq!(loaded.payload.cursor, original_payload.cursor);
        assert_eq!(loaded.payload.mode, original_payload.mode);
        // Signature is valid (verified during load).
    }

    #[test]
    fn test_load_nonexistent_document_returns_none() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("nonexistent.ht");

        let result = load_document(&path).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_load_tampered_document_fails() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("tampered.ht");

        // Create a valid document using the keychain key.
        let payload = new_document_payload("# Original".to_string());
        save_document(&path, payload).unwrap();

        // Tamper with the file on disk.
        let json = fs::read_to_string(&path).unwrap();
        let mut tampered: serde_json::Value = serde_json::from_str(&json).unwrap();
        tampered["payload"]["markdown"] = serde_json::json!("# Tampered");
        let tampered_json = serde_json::to_string(&tampered).unwrap();
        fs::write(&path, tampered_json).unwrap();

        let result = load_document(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("verification failed"));
    }

    #[test]
    fn test_unverified_load_succeeds_for_tampered_doc() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("tampered.ht");

        // Create and tamper a document.
        let key = test_key();
        let payload = new_document_payload("# Original".to_string());
        let mut doc = SignedDocument::new(payload, &key);
        doc.payload.markdown = "# Tampered".to_string();

        let json = serde_json::to_string(&doc).unwrap();
        fs::write(&path, json).unwrap();

        // Unverified load should still work.
        let loaded = load_document_unverified(&path).unwrap().unwrap();
        assert_eq!(loaded.payload.markdown, "# Tampered");
    }

    #[test]
    fn test_save_document_creates_file() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("new.ht");

        let payload = new_document_payload("# New".to_string());
        save_document(&path, payload).unwrap();

        assert!(path.exists());
        assert!(path.is_file());
    }

    #[test]
    fn test_save_document_creates_valid_json() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("valid.ht");

        let payload = new_document_payload("# Test".to_string());
        save_document(&path, payload).unwrap();

        let json = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["format"], "handtyped-signed-doc-v1");
        assert!(parsed["payload"].is_object());
        assert!(parsed["signature_hex"].is_string());
    }

    // ========================================================================
    // Undo History Tests
    // ========================================================================

    #[test]
    fn test_undo_history_preserved_in_payload() {
        let key = test_key();
        let mut payload = new_document_payload("Initial".to_string());
        payload.undo_changes = vec![
            TextChange {
                pos: 0,
                del: "Initial".to_string(),
                ins: "First edit".to_string(),
                cursor_before: 0,
                cursor_after: 0,
            },
            TextChange {
                pos: 0,
                del: "First edit".to_string(),
                ins: "Second edit".to_string(),
                cursor_before: 0,
                cursor_after: 0,
            },
        ];
        payload.undo_index = 2;

        let doc = SignedDocument::new(payload.clone(), &key);

        assert_eq!(doc.payload.undo_changes.len(), 2);
        assert_eq!(doc.payload.undo_index, 2);
        assert!(doc.verify(&key.verifying_key()));
    }

    #[test]
    fn test_undo_history_roundtrip() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("undo.ht");

        let mut payload = new_document_payload("v1".to_string());
        payload.undo_changes = vec![
            TextChange {
                pos: 1,
                del: "1".to_string(),
                ins: "2".to_string(),
                cursor_before: 0,
                cursor_after: 0,
            },
            TextChange {
                pos: 1,
                del: "2".to_string(),
                ins: "3".to_string(),
                cursor_before: 0,
                cursor_after: 0,
            },
        ];
        payload.undo_index = 1;

        save_document(&path, payload.clone()).unwrap();
        let loaded = load_document(&path).unwrap().unwrap();

        assert_eq!(loaded.payload.undo_changes, payload.undo_changes);
        assert_eq!(loaded.payload.undo_index, payload.undo_index);
    }

    #[test]
    fn test_doc_history_roundtrip() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("replay-history.ht");

        let mut payload = new_document_payload("hello".to_string());
        payload.doc_history = vec![
            serde_json::json!({ "t": 0_u64, "pos": 0_usize, "del": "", "ins": "he" }),
            serde_json::json!({ "t": 50_u64, "pos": 2_usize, "del": "", "ins": "llo" }),
        ];

        save_document(&path, payload.clone()).unwrap();
        let loaded = load_document(&path).unwrap().unwrap();

        assert_eq!(loaded.payload.doc_history, payload.doc_history);
    }

    #[test]
    fn test_legacy_undo_revisions_are_normalized_on_load() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("legacy-undo.ht");

        let key = test_key();
        let payload = serde_json::json!({
            "markdown": "v3",
            "cursor": 0,
            "mode": "source",
            "theme": null,
            "undo_revisions": ["v1", "v2", "v3"],
            "undo_index": 2,
            "session_keystrokes": [],
            "doc_history": [],
            "session_nonce": "nonce",
            "created_at": "2026-01-01T00:00:00Z",
            "modified_at": "2026-01-01T00:00:00Z"
        });
        let sig = key.sign(&serde_json::to_vec(&payload).unwrap());
        let doc = serde_json::json!({
            "version": FORMAT_VERSION,
            "format": FORMAT_MARKER,
            "payload": payload,
            "signature_hex": hex::encode(sig.to_bytes()),
        });
        fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();

        let loaded = load_document_unverified(&path).unwrap().unwrap();
        assert_eq!(loaded.payload.undo_index, 2);
        assert_eq!(loaded.payload.undo_changes.len(), 2);
        assert!(loaded.payload.legacy_undo_revisions.is_empty());
    }

    // ========================================================================
    // Session Continuity Tests
    // ========================================================================

    #[test]
    fn test_session_nonce_preserved_across_saves() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("session.ht");

        // First save.
        let payload1 = new_document_payload("v1".to_string());
        let nonce1 = payload1.session_nonce.clone();
        save_document(&path, payload1).unwrap();

        // Second save (simulating edit).
        let mut payload2 = new_document_payload("v2".to_string());
        payload2.session_nonce = nonce1.clone(); // Preserve nonce
        save_document(&path, payload2).unwrap();

        let loaded = load_document(&path).unwrap().unwrap();
        assert_eq!(loaded.payload.session_nonce, nonce1);
    }

    #[test]
    fn test_created_at_preserved_across_saves() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("timestamps.ht");

        // First save.
        let payload1 = new_document_payload("v1".to_string());
        let created1 = payload1.created_at.clone();
        save_document(&path, payload1).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(10));

        // Second save.
        let mut payload2 = new_document_payload("v2".to_string());
        payload2.created_at = created1.clone(); // Preserve creation time
        save_document(&path, payload2).unwrap();

        let loaded = load_document(&path).unwrap().unwrap();
        assert_eq!(loaded.payload.created_at, created1);
        // modified_at should be different
        assert_ne!(loaded.payload.modified_at, created1);
    }

    // ========================================================================
    // Edge Cases
    // ========================================================================

    #[test]
    fn test_special_characters_in_markdown() {
        let key = test_key();
        let special = r#"# Special Chars

- Quotes: "double" and 'single'
- Backslash: \\
- Newlines: \n
- Tabs: \t
- JSON-like: {"key": "value"}
- HTML: <div>test</div>
"#
        .to_string();

        let payload = new_document_payload(special.clone());
        let doc = SignedDocument::new(payload, &key);

        assert!(doc.verify(&key.verifying_key()));
        assert_eq!(doc.payload.markdown, special);
    }

    #[test]
    fn test_null_bytes_in_markdown() {
        let key = test_key();
        // Null bytes in strings are rare but should be handled.
        let markdown = "Before\0After".to_string();
        let payload = new_document_payload(markdown.clone());
        let doc = SignedDocument::new(payload, &key);

        assert!(doc.verify(&key.verifying_key()));
        assert_eq!(doc.payload.markdown, markdown);
    }

    #[test]
    fn test_very_long_line() {
        let key = test_key();
        let long_line = "x".repeat(1_000_000); // 1 million characters
        let payload = new_document_payload(long_line.clone());
        let doc = SignedDocument::new(payload, &key);

        assert!(doc.verify(&key.verifying_key()));
        assert_eq!(doc.payload.markdown.len(), 1_000_000);
    }

    #[test]
    fn test_many_undo_revisions() {
        let key = test_key();
        let mut payload = new_document_payload("v0".to_string());
        payload.undo_changes = (0..1000)
            .map(|i| TextChange {
                pos: 0,
                del: format!("version {}", i),
                ins: format!("version {}", i + 1),
                cursor_before: 0,
                cursor_after: 0,
            })
            .collect();
        payload.undo_index = 500;

        let doc = SignedDocument::new(payload, &key);

        assert!(doc.verify(&key.verifying_key()));
        assert_eq!(doc.payload.undo_changes.len(), 1000);
        assert_eq!(doc.payload.undo_index, 500);
    }

    #[test]
    fn test_cursor_at_various_positions() {
        let key = test_key();
        let markdown = "Hello, World!";

        for cursor_pos in [0, 5, 13, 100] {
            let mut payload = new_document_payload(markdown.to_string());
            payload.cursor = cursor_pos;
            let doc = SignedDocument::new(payload.clone(), &key);

            assert!(doc.verify(&key.verifying_key()));
            assert_eq!(doc.payload.cursor, cursor_pos);
        }
    }

    #[test]
    fn test_all_editor_modes() {
        let key = test_key();

        for mode in [EditorMode::Source, EditorMode::Split] {
            let mut payload = new_document_payload("# Test".to_string());
            payload.mode = mode.clone();
            let doc = SignedDocument::new(payload.clone(), &key);

            assert!(doc.verify(&key.verifying_key()));
            assert_eq!(doc.payload.mode, mode);
        }
    }
}
