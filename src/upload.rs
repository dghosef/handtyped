use crate::observability;
use crate::session::AppState;
use crate::signing;
use base64::Engine as _;
use chrono::Local;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::time::Duration;

const REPLAY_ORIGIN: &str = "https://replay.handtyped.app";
const REPLAY_API_URL: &str = "https://replay.handtyped.app/api/sessions";
pub const REPLAY_ATTESTATION_FORMAT_V1: &str = "handtyped-replay-attestation-v1";
pub const REPLAY_ATTESTATION_FORMAT_V2: &str = "handtyped-replay-attestation-v2";
const REPLAY_CONNECT_TIMEOUT_SECS: u64 = 5;
const REPLAY_REQUEST_TIMEOUT_SECS: u64 = 20;
const REPLAY_SIGNING_TIMEOUT_SECS: u64 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayAttestationPayload {
    pub session_id: String,
    pub session_nonce: String,
    pub document_name: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_gzip_b64: Option<String>,
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
    document_name: Option<&str>,
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
        document_name: document_name.map(str::to_owned),
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

fn gzip_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(data).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn build_replay_attestation_envelope(
    payload: &ReplayAttestationPayload,
    progress: &mut dyn FnMut(&'static str),
) -> Result<ReplayAttestationEnvelope, String> {
    progress("Preparing replay signature...");
    let payload_json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let payload_gzip = gzip_bytes(payload_json.as_bytes())?;
    let key =
        signing::load_or_create_key_with_timeout(Duration::from_secs(REPLAY_SIGNING_TIMEOUT_SECS))?;
    let signature = signing::sign(&key, &payload_gzip);

    Ok(ReplayAttestationEnvelope {
        version: 2,
        format: REPLAY_ATTESTATION_FORMAT_V2.to_string(),
        signer_pubkey_hex: hex::encode(key.verifying_key().to_bytes()),
        payload_json: None,
        payload_gzip_b64: Some(base64::engine::general_purpose::STANDARD.encode(payload_gzip)),
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

fn encode_envelope_body(envelope: &ReplayAttestationEnvelope) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(envelope).map_err(|e| e.to_string())?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(&json).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn format_replay_server_error(status: reqwest::StatusCode, body: &str) -> String {
    let server_error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|json| {
            json.get("error")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.trim().to_string());

    if server_error.is_empty() {
        status.to_string()
    } else {
        format!("{status}: {server_error}")
    }
}

fn detect_unexpected_html_response(body: &str) -> Option<String> {
    let trimmed = body.trim();
    let lower = trimmed.to_ascii_lowercase();

    if !(lower.starts_with("<!doctype html") || lower.starts_with("<html")) {
        return None;
    }

    if lower.contains("cloudflare registrar") || lower.contains("parking.registrar.cloudflare.com")
    {
        return Some(
            "Replay server returned an HTML parking page instead of API JSON. The replay domain looks misconfigured or parked right now.".to_string(),
        );
    }

    Some("Replay server returned HTML instead of API JSON.".to_string())
}

fn extract_replay_url_from_success_body(body: &str) -> Result<String, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Replay server returned an empty success body".to_string());
    }

    if let Some(detail) = detect_unexpected_html_response(trimmed) {
        return Err(detail);
    }

    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(url) = json.get("url").and_then(|value| value.as_str()) {
            return Ok(url.to_string());
        }
        if let Some(url) = json.as_str() {
            return Ok(url.to_string());
        }
        return Err("No 'url' field in replay server response".to_string());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(trimmed.to_string());
    }

    Err(format!("Bad JSON from replay server: {trimmed}"))
}

/// Upload a replay session to the public replay server.
/// Returns the replay URL on success, or an error string on failure.
pub fn upload_replay_session_native(
    state: &AppState,
    document_name: Option<&str>,
    doc_text: &str,
    doc_history: &[serde_json::Value],
) -> Result<String, String> {
    upload_replay_session_native_with_progress(state, document_name, doc_text, doc_history, |_| {})
}

pub fn upload_replay_session_native_with_progress<F: FnMut(&'static str)>(
    state: &AppState,
    document_name: Option<&str>,
    doc_text: &str,
    doc_history: &[serde_json::Value],
    mut progress: F,
) -> Result<String, String> {
    let payload = build_replay_attestation_payload(state, document_name, doc_text, doc_history);
    let session_id = payload.session_id.clone();
    let document_name_owned = payload.document_name.clone();
    let envelope = build_replay_attestation_envelope(&payload, &mut progress)?;

    progress("Contacting replay server...");
    let client = build_upload_client()?;
    let body = encode_envelope_body(&envelope)?;
    progress("Uploading replay...");
    let response = client
        .post(REPLAY_API_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::CONTENT_ENCODING, "gzip")
        .body(body)
        .send()
        .map_err(|e| {
            let detail = format!("Cannot connect to replay server at {REPLAY_ORIGIN}: {e}");
            observability::record_upload_failure(
                &state.observability,
                Some(&session_id),
                document_name_owned.as_deref(),
                &detail,
            );
            detail
        })?;

    let response = if response.status().is_success() {
        response
    } else {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        let detail = format_replay_server_error(status, &body);
        observability::record_upload_failure(
            &state.observability,
            Some(&session_id),
            document_name_owned.as_deref(),
            &detail,
        );
        return Err(format!("Replay server returned an error: {detail}"));
    };

    let response_body = response.text().map_err(|e| {
        let detail = format!("Bad response body from replay server: {e}");
        observability::record_upload_failure(
            &state.observability,
            Some(&session_id),
            document_name_owned.as_deref(),
            &detail,
        );
        detail
    })?;
    progress("Finalizing replay...");

    let url = extract_replay_url_from_success_body(&response_body).map_err(|detail| {
        observability::record_upload_failure(
            &state.observability,
            Some(&session_id),
            document_name_owned.as_deref(),
            &detail,
        );
        detail
    })?;
    observability::record_upload_success(
        &state.observability,
        Some(&session_id),
        document_name_owned.as_deref(),
        Some(&url),
    );

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
        let payload = build_replay_attestation_payload(state, None, doc_text, doc_history);
        let envelope = build_replay_attestation_envelope(&payload, &mut |_| {})?;
        let body = encode_envelope_body(&envelope)?;

        let client = build_upload_client()?;
        client
            .post("http://127.0.0.1:19999/api/sessions")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::CONTENT_ENCODING, "gzip")
            .body(body)
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
            observability: Mutex::new(observability::RuntimeObservability::default()),
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
            observability: Mutex::new(observability::RuntimeObservability::default()),
        };

        let payload = build_replay_attestation_payload(&state, Some("document.ht"), "hello", &[]);
        let envelope = build_replay_attestation_envelope(&payload, &mut |_| {}).unwrap();
        assert_eq!(envelope.version, 2);
        assert_eq!(envelope.format, REPLAY_ATTESTATION_FORMAT_V2);
        assert!(!envelope.signer_pubkey_hex.is_empty());
        assert!(!envelope.signature_hex.is_empty());
        let payload_gzip_b64 = envelope.payload_gzip_b64.as_ref().unwrap();
        let payload_bytes = base64::engine::general_purpose::STANDARD
            .decode(payload_gzip_b64)
            .unwrap();
        let mut decoder = flate2::read::GzDecoder::new(payload_bytes.as_slice());
        let payload: ReplayAttestationPayload = serde_json::from_reader(&mut decoder).unwrap();
        assert_eq!(payload.document_name.as_deref(), Some("document.ht"));
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
            observability: Mutex::new(observability::RuntimeObservability::default()),
        };

        let mut stages = Vec::new();
        let _ = upload_replay_session_native_with_progress(&state, None, "test", &[], |stage| {
            stages.push(stage.to_string());
        });

        assert!(!stages.is_empty());
        assert_eq!(stages[0], "Preparing replay signature...");
        assert!(stages
            .iter()
            .any(|stage| stage == "Contacting replay server..."));
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

    #[test]
    fn replay_success_body_accepts_plaintext_url_regression() {
        let url = extract_replay_url_from_success_body("https://replay.handtyped.app/replay/abc")
            .expect("plaintext success body should still yield replay url");

        assert_eq!(url, "https://replay.handtyped.app/replay/abc");
    }

    #[test]
    fn replay_success_body_accepts_json_string_url() {
        let url =
            extract_replay_url_from_success_body("\"https://replay.handtyped.app/replay/abc\"")
                .expect("json string success body should still yield replay url");

        assert_eq!(url, "https://replay.handtyped.app/replay/abc");
    }

    #[test]
    fn replay_success_body_rejects_non_url_non_json_text() {
        let detail = extract_replay_url_from_success_body("<html>not json</html>")
            .expect_err("non-json success body should still surface a parsing error");

        assert!(
            detail.contains("Bad JSON from replay server")
                || detail.contains("returned HTML instead of API JSON")
        );
    }

    #[test]
    fn replay_success_body_rejects_cloudflare_parking_html_with_clear_error() {
        let detail = extract_replay_url_from_success_body(
            r#"<!doctype html>
<html lang="en">
  <head><title>Cloudflare Registrar</title></head>
  <body>parking.registrar.cloudflare.com</body>
</html>"#,
        )
        .expect_err("parking html should surface a domain-specific error");

        assert!(detail.contains("parking page"));
        assert!(detail.contains("misconfigured") || detail.contains("parked"));
    }

    #[test]
    fn encode_envelope_body_roundtrips_as_gzip_json() {
        let envelope = ReplayAttestationEnvelope {
            version: 2,
            format: REPLAY_ATTESTATION_FORMAT_V2.to_string(),
            signer_pubkey_hex: "ab".repeat(32),
            payload_json: None,
            payload_gzip_b64: Some(
                base64::engine::general_purpose::STANDARD
                    .encode(gzip_bytes(br#"{"hello":"world"}"#).unwrap()),
            ),
            signature_hex: "cd".repeat(64),
        };

        let body = encode_envelope_body(&envelope).expect("gzip body");
        let mut decoder = flate2::read::GzDecoder::new(body.as_slice());
        let decoded: ReplayAttestationEnvelope =
            serde_json::from_reader(&mut decoder).expect("decode envelope json");

        assert_eq!(decoded.version, envelope.version);
        assert_eq!(decoded.format, envelope.format);
        assert_eq!(decoded.payload_gzip_b64, envelope.payload_gzip_b64);
    }
}
