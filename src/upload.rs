use crate::session::AppState;
use crate::signing;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const REPLAY_ORIGIN: &str = "https://replay.handtyped.app";
const REPLAY_API_URL: &str = "https://replay.handtyped.app/api/sessions";
pub const REPLAY_ATTESTATION_FORMAT: &str = "handtyped-replay-attestation-v1";
const REPLAY_CONNECT_TIMEOUT_SECS: u64 = 5;
const REPLAY_REQUEST_TIMEOUT_SECS: u64 = 20;
const REPLAY_SIGNING_TIMEOUT_SECS: u64 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayAttestationPayload {
    pub session_id: String,
    pub session_nonce: String,
    pub doc_text: String,
    pub doc_html: String,
    pub doc_history: Vec<serde_json::Value>,
    pub keystroke_log: String,
    pub keystroke_count: usize,
    pub start_wall_ns: u64,
    pub log_chain_hash: String,
    pub app_binary_hash: String,
    pub code_signing_valid: bool,
    pub os_version: String,
    pub hardware_model: String,
    pub hardware_uuid: String,
    pub sip_enabled: bool,
    pub vm_detected: bool,
    pub frida_detected: bool,
    pub dylib_injection_detected: bool,
    pub dyld_env_injection: bool,
    pub keyboard_vendor_id: Option<String>,
    pub keyboard_product_id: Option<String>,
    pub keyboard_transport: Option<String>,
    pub recorded_timezone: String,
    pub recorded_timezone_offset_minutes: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayAttestationEnvelope {
    pub version: u32,
    pub format: String,
    pub signer_pubkey_hex: String,
    pub payload_json: String,
    pub signature_hex: String,
}

fn recorded_timezone_payload() -> (String, i32) {
    let now = Local::now();
    let offset_seconds = now.offset().local_minus_utc();
    let offset_minutes = offset_seconds / 60;
    let label = now.format("%Z").to_string();
    (label, offset_minutes)
}

fn build_replay_attestation_payload(
    state: &AppState,
    doc_text: &str,
    doc_history: &[serde_json::Value],
) -> ReplayAttestationPayload {
    let (session_id, session_nonce, log_jsonl, keystroke_count, start_wall_ns, log_chain_hash) = {
        let s = state.session.lock().unwrap();
        (
            s.session_id.clone(),
            s.session_nonce.clone(),
            s.to_jsonl(),
            s.keystroke_count(),
            s.start_wall_ns,
            s.log_chain_hash(),
        )
    };

    let integrity = state.integrity.clone();
    let keyboard = state.keyboard_info.lock().unwrap().clone();
    let hid_active = state.hid_active.load(std::sync::atomic::Ordering::Acquire);
    let (recorded_timezone, recorded_timezone_offset_minutes) = recorded_timezone_payload();
    let keyboard_transport = keyboard
        .as_ref()
        .map(|k| k.transport.clone())
        .or_else(|| hid_active.then(|| "SPI".to_string()));

    ReplayAttestationPayload {
        session_id,
        session_nonce,
        doc_text: doc_text.to_string(),
        doc_html: String::new(),
        doc_history: doc_history.to_vec(),
        keystroke_log: log_jsonl,
        keystroke_count,
        start_wall_ns,
        log_chain_hash,
        app_binary_hash: integrity.app_binary_hash,
        code_signing_valid: integrity.code_signing_valid,
        os_version: integrity.os_version,
        hardware_model: integrity.hardware_model,
        hardware_uuid: integrity.hardware_uuid,
        sip_enabled: integrity.sip_enabled,
        vm_detected: integrity.vm_detected,
        frida_detected: integrity.frida_detected,
        dylib_injection_detected: integrity.dylib_injection_detected,
        dyld_env_injection: integrity.dyld_env_injection,
        keyboard_vendor_id: keyboard.as_ref().map(|k| format!("0x{:04x}", k.vendor_id)),
        keyboard_product_id: keyboard.as_ref().map(|k| format!("0x{:04x}", k.product_id)),
        keyboard_transport,
        recorded_timezone,
        recorded_timezone_offset_minutes,
    }
}

fn build_replay_attestation_envelope(
    state: &AppState,
    doc_text: &str,
    doc_history: &[serde_json::Value],
    progress: &mut dyn FnMut(&'static str),
) -> Result<ReplayAttestationEnvelope, String> {
    progress("Preparing replay signature...");
    let payload = build_replay_attestation_payload(state, doc_text, doc_history);
    let payload_json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let key =
        signing::load_or_create_key_with_timeout(Duration::from_secs(REPLAY_SIGNING_TIMEOUT_SECS))?;
    let signature = signing::sign(&key, payload_json.as_bytes());

    Ok(ReplayAttestationEnvelope {
        version: 1,
        format: REPLAY_ATTESTATION_FORMAT.to_string(),
        signer_pubkey_hex: hex::encode(key.verifying_key().to_bytes()),
        payload_json,
        signature_hex: hex::encode(signature),
    })
}

fn build_upload_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(REPLAY_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(REPLAY_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Cannot initialize replay upload client: {e}"))
}

fn format_replay_server_error(status: reqwest::StatusCode, body: &str) -> String {
    let server_error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|json| json.get("error").and_then(|value| value.as_str()).map(str::to_owned))
        .unwrap_or_else(|| body.trim().to_string());

    if server_error.is_empty() {
        status.to_string()
    } else {
        format!("{status}: {server_error}")
    }
}

/// Upload a replay session to the public replay server.
/// Returns the replay URL on success, or an error string on failure.
pub fn upload_replay_session_native(
    state: &AppState,
    doc_text: &str,
    doc_history: &[serde_json::Value],
) -> Result<String, String> {
    upload_replay_session_native_with_progress(state, doc_text, doc_history, |_| {})
}

pub fn upload_replay_session_native_with_progress<F: FnMut(&'static str)>(
    state: &AppState,
    doc_text: &str,
    doc_history: &[serde_json::Value],
    mut progress: F,
) -> Result<String, String> {
    let envelope =
        build_replay_attestation_envelope(state, doc_text, doc_history, &mut progress)?;

    progress("Contacting replay server...");
    let client = build_upload_client()?;
    progress("Uploading replay...");
    let response = client
        .post(REPLAY_API_URL)
        .json(&envelope)
        .send()
        .map_err(|e| format!("Cannot connect to replay server at {REPLAY_ORIGIN}: {e}"))?;

    let response = if response.status().is_success() {
        response
    } else {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        let detail = format_replay_server_error(status, &body);
        return Err(format!("Replay server returned an error: {detail}"));
    };

    let resp_json: serde_json::Value = response
        .json()
        .map_err(|e| format!("Bad JSON from replay server: {e}"))?;
    progress("Finalizing replay...");

    let url = resp_json["url"]
        .as_str()
        .ok_or("No 'url' field in replay server response")?
        .to_string();

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: call upload_replay_session_native but override the connect address to a
    /// port that is guaranteed to have nothing listening.
    fn upload_with_dead_port(
        state: &AppState,
        doc_text: &str,
        doc_history: &[serde_json::Value],
    ) -> Result<String, String> {
        let envelope =
            build_replay_attestation_envelope(state, doc_text, doc_history, &mut |_| {})?;

        let client = build_upload_client()?;
        client
            .post("http://127.0.0.1:19999/api/sessions")
            .json(&envelope)
            .send()
            .map_err(|e| {
                format!("Cannot connect to replay server at http://127.0.0.1:19999: {e}")
            })?;
        Ok(String::new())
    }

    #[test]
    fn upload_fails_gracefully_when_server_down() {
        use crate::editor::EditorDocumentState;
        use crate::session::SessionState;
        use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64};
        use std::sync::Mutex;

        let state = AppState {
            session: Mutex::new(SessionState::new(0)),
            editor_state: Mutex::new(EditorDocumentState::default()),
            hid_active: AtomicBool::new(false),
            pending_builtin_keydowns: AtomicI32::new(0),
            integrity: Default::default(),
            keyboard_info: Mutex::new(None),
            last_keydown_ns: AtomicU64::new(0),
        };

        let result = upload_with_dead_port(&state, "test doc", &[]);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(
            msg.contains("Cannot connect") || msg.contains("connect"),
            "got: {msg}"
        );
    }

    #[test]
    fn replay_attestation_envelope_contains_signed_payload() {
        use crate::editor::EditorDocumentState;
        use crate::session::SessionState;
        use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64};
        use std::sync::Mutex;

        let state = AppState {
            session: Mutex::new(SessionState::new(0)),
            editor_state: Mutex::new(EditorDocumentState::default()),
            hid_active: AtomicBool::new(false),
            pending_builtin_keydowns: AtomicI32::new(0),
            integrity: Default::default(),
            keyboard_info: Mutex::new(None),
            last_keydown_ns: AtomicU64::new(0),
        };

        let envelope =
            build_replay_attestation_envelope(&state, "hello", &[], &mut |_| {}).unwrap();
        assert_eq!(envelope.version, 1);
        assert_eq!(envelope.format, REPLAY_ATTESTATION_FORMAT);
        assert!(!envelope.signer_pubkey_hex.is_empty());
        assert!(!envelope.signature_hex.is_empty());

        let payload: ReplayAttestationPayload =
            serde_json::from_str(&envelope.payload_json).unwrap();
        assert_eq!(payload.doc_text, "hello");
        assert!(!payload.session_nonce.is_empty());
    }

    #[test]
    fn replay_upload_emits_progress_stages_before_connect() {
        use crate::editor::EditorDocumentState;
        use crate::session::SessionState;
        use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64};
        use std::sync::Mutex;

        let state = AppState {
            session: Mutex::new(SessionState::new(0)),
            editor_state: Mutex::new(EditorDocumentState::default()),
            hid_active: AtomicBool::new(false),
            pending_builtin_keydowns: AtomicI32::new(0),
            integrity: Default::default(),
            keyboard_info: Mutex::new(None),
            last_keydown_ns: AtomicU64::new(0),
        };

        let mut stages = Vec::new();
        let _ = upload_replay_session_native_with_progress(&state, "test", &[], |stage| {
            stages.push(stage.to_string());
        });

        assert!(!stages.is_empty());
        assert_eq!(stages[0], "Preparing replay signature...");
        assert!(stages.iter().any(|stage| stage == "Contacting replay server..."));
    }

    #[test]
    fn replay_server_error_prefers_json_error_field() {
        let detail = format_replay_server_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":"Untrusted Handtyped signer public key"}"#,
        );

        assert_eq!(
            detail,
            "400 Bad Request: Untrusted Handtyped signer public key"
        );
    }

    #[test]
    fn replay_server_error_falls_back_to_plaintext_body() {
        let detail =
            format_replay_server_error(reqwest::StatusCode::BAD_REQUEST, "plain failure body");

        assert_eq!(detail, "400 Bad Request: plain failure body");
    }

    #[test]
    fn replay_server_error_falls_back_to_status_when_body_is_empty() {
        let detail = format_replay_server_error(reqwest::StatusCode::BAD_REQUEST, "");

        assert_eq!(detail, "400 Bad Request");
    }
}
