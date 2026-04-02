use crate::bundle;
use crate::document::{self, DocumentPayload};
use crate::editor::{self, EditorDocumentState, EditorMode};
use crate::session::{AppState, ExtraEvent};
use crate::signing;
use base64::Engine as _;
use std::fs;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

fn document_store_dir() -> std::path::PathBuf {
    let mut path = dirs_next::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    path.push("handtyped");
    path.push("vault");
    path
}

fn document_store_path() -> std::path::PathBuf {
    let mut path = document_store_dir();
    path.push("autosave.handtyped");
    path
}

fn consume_pending_builtin_keydown(counter: &AtomicI32) -> bool {
    let prev = counter.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    if prev <= 0 {
        counter.store(0, std::sync::atomic::Ordering::SeqCst);
        return false;
    }
    true
}

/// Log a paste event. `content_hash` is the SHA-256 hex of the pasted text
/// (computed in JS via crypto.subtle so the raw content never leaves the frontend).
#[tauri::command]
pub fn log_paste_event(char_count: usize, content_hash: String, state: State<Arc<AppState>>) {
    let mut s = state.session.lock().unwrap();
    s.append_extra(ExtraEvent {
        t: now_ns(),
        kind: "paste".into(),
        char_count: Some(char_count),
        duration_ms: None,
        content_hash: Some(content_hash),
    });
}

#[tauri::command]
pub fn log_focus_loss_event(duration_ms: u64, state: State<Arc<AppState>>) {
    let mut s = state.session.lock().unwrap();
    s.append_extra(ExtraEvent {
        t: now_ns(),
        kind: "focus_loss".into(),
        char_count: None,
        duration_ms: Some(duration_ms),
        content_hash: None,
    });
}

#[tauri::command]
pub fn get_keystroke_count(state: State<Arc<AppState>>) -> usize {
    state.session.lock().unwrap().keystroke_count()
}

#[tauri::command]
pub fn get_hid_status(state: State<Arc<AppState>>) -> bool {
    state.hid_active.load(Ordering::Acquire)
}

#[tauri::command]
pub fn consume_builtin_keydown(state: State<Arc<AppState>>) -> bool {
    consume_pending_builtin_keydown(&state.pending_builtin_keydowns)
}

#[tauri::command]
pub fn open_input_monitoring_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        .spawn();
}

#[tauri::command]
pub fn save_session_payload(payload_b64: String) -> Result<(), String> {
    let dir = document_store_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(payload_b64)
        .map_err(|e| format!("Invalid encrypted payload: {e}"))?;
    fs::write(document_store_path(), ciphertext).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_session_payload() -> Result<Option<String>, String> {
    let path = document_store_path();
    if !path.exists() {
        return Ok(None);
    }
    let ciphertext = fs::read(path).map_err(|e| e.to_string())?;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(ciphertext),
    ))
}

#[tauri::command]
pub fn get_document_store_key() -> Result<String, String> {
    let key = signing::derive_document_store_key()?;
    Ok(base64::engine::general_purpose::STANDARD.encode(key))
}

#[tauri::command]
pub fn load_editor_state(state: State<Arc<AppState>>) -> Result<EditorDocumentState, String> {
    if let Some(saved) = editor::load_editor_state_from_disk()? {
        let mut current = state.editor_state.lock().unwrap();
        *current = saved.clone();
        return Ok(saved);
    }

    Ok(state.editor_state.lock().unwrap().clone())
}

#[tauri::command]
pub fn save_editor_state(
    markdown: String,
    cursor: usize,
    mode: String,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    let parsed_mode = match mode.as_str() {
        "split" => EditorMode::Split,
        _ => EditorMode::Source,
    };

    let next = EditorDocumentState {
        markdown,
        cursor,
        mode: parsed_mode,
        theme: None,
        undo_changes: Vec::new(),
        undo_index: 0,
        recent_files: Vec::new(),
        legacy_undo_revisions: Vec::new(),
    };

    {
        let mut current = state.editor_state.lock().unwrap();
        *current = next.clone();
    }

    editor::save_editor_state_to_disk(&next)
}

#[tauri::command]
pub async fn upload_replay_session(
    doc_text: String,
    doc_html: String,
    doc_history: Vec<serde_json::Value>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let now_local = chrono::Local::now();
    let recorded_timezone = now_local.format("%Z").to_string();
    let recorded_timezone_offset_minutes = now_local.offset().local_minus_utc() / 60;
    let (session_id, log_jsonl, keystroke_count, start_wall_ns, log_chain_hash) = {
        let s = state.session.lock().unwrap();
        (
            s.session_id.clone(),
            s.to_jsonl(),
            s.keystroke_count(),
            s.start_wall_ns,
            s.log_chain_hash(),
        )
    };

    let integrity = state.integrity.clone();
    let keyboard = state.keyboard_info.lock().unwrap().clone();

    let payload = serde_json::json!({
        "session_id": session_id,
        "doc_text": doc_text,
        "doc_html": doc_html,
        "doc_history": doc_history,
        "keystroke_log": log_jsonl,
        "keystroke_count": keystroke_count,
        "start_wall_ns": start_wall_ns,
        "log_chain_hash": log_chain_hash,
        // Integrity fields
        "app_binary_hash": integrity.app_binary_hash,
        "code_signing_valid": integrity.code_signing_valid,
        "os_version": integrity.os_version,
        "hardware_model": integrity.hardware_model,
        "hardware_uuid": integrity.hardware_uuid,
        "sip_enabled": integrity.sip_enabled,
        "vm_detected": integrity.vm_detected,
        "frida_detected": integrity.frida_detected,
        "dylib_injection_detected": integrity.dylib_injection_detected,
        "dyld_env_injection": integrity.dyld_env_injection,
        // Keyboard
        "keyboard_vendor_id": keyboard.as_ref().map(|k| format!("0x{:04x}", k.vendor_id)),
        "keyboard_transport": keyboard.as_ref().map(|k| k.transport.clone()),
        "recorded_timezone": recorded_timezone,
        "recorded_timezone_offset_minutes": recorded_timezone_offset_minutes,
    });

    let resp_json: serde_json::Value = reqwest::Client::new()
        .post("https://replay.handtyped.app/api/sessions")
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            format!("Cannot connect to replay server at https://replay.handtyped.app: {e}")
        })?
        .error_for_status()
        .map_err(|e| format!("Replay server returned an error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Bad response from replay server: {e}"))?;

    let url = resp_json["url"]
        .as_str()
        .ok_or("No url in response")?
        .to_string();

    Ok(url)
}

#[tauri::command]
pub async fn export_bundle(
    doc_text: String,
    doc_html: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let integrity = state.integrity.clone();
    let keyboard = state.keyboard_info.lock().unwrap().clone();
    let input = {
        let s = state.session.lock().unwrap();
        bundle::BundleInput {
            session_id: s.session_id.clone(),
            session_nonce: s.session_nonce.clone(),
            start_wall_ns: s.start_wall_ns,
            log_jsonl: s.to_jsonl(),
            keystroke_count: s.keystroke_count(),
            log_chain_hash: s.log_chain_hash(),
            integrity,
            keyboard_vendor_id: keyboard.as_ref().map(|k| k.vendor_id),
            keyboard_transport: keyboard.as_ref().map(|k| k.transport.clone()),
        }
    };
    bundle::build_and_sign(input, doc_text, doc_html)
}

/// Create a new blank document.
#[tauri::command]
pub fn new_document() -> Result<(), String> {
    // This is handled by the frontend calling back into the app.
    // The actual logic lives in NativeEditorApp.
    Ok(())
}

/// Open a Handtyped document from disk.
#[tauri::command]
pub fn open_document(path: String) -> Result<DocumentPayload, String> {
    let path = std::path::PathBuf::from(path);
    let doc = document::load_document(&path)?.ok_or_else(|| "File not found".to_string())?;
    Ok(doc.payload)
}

/// Save a document to disk.
#[tauri::command]
pub fn save_document(path: String, payload: DocumentPayload) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    document::save_document(&path, payload)
}

/// Create a new document payload with default values.
#[tauri::command]
pub fn create_document_payload(markdown: String) -> Result<DocumentPayload, String> {
    Ok(document::new_document_payload(markdown))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn test_consume_pending_builtin_keydown_rejects_without_hid_credit() {
        let pending = AtomicI32::new(0);

        assert!(!consume_pending_builtin_keydown(&pending));
        assert_eq!(pending.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_consume_pending_builtin_keydown_accepts_hid_credit_once() {
        let pending = AtomicI32::new(1);

        assert!(consume_pending_builtin_keydown(&pending));
        assert_eq!(pending.load(Ordering::SeqCst), 0);
        assert!(!consume_pending_builtin_keydown(&pending));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires macOS System Events permission and a focused app window"]
    fn test_osascript_keystroke_does_not_create_builtin_hid_credit() {
        let pending = AtomicI32::new(0);

        let _ = Command::new("osascript")
            .arg("-e")
            .arg(r#"tell application "System Events" to keystroke "a""#)
            .status()
            .expect("osascript should be available on macOS");

        std::thread::sleep(Duration::from_millis(100));

        assert!(
            !consume_pending_builtin_keydown(&pending),
            "osascript should not increment the built-in HID keydown counter"
        );
        assert_eq!(pending.load(Ordering::SeqCst), 0);
    }
}
