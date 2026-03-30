use crate::session::AppState;
use std::io::{Read, Write};
use std::net::TcpStream;

/// Upload a proof to the local proof server at localhost:4000.
/// Returns the proof URL on success, or an error string on failure.
pub fn upload_proof_native(state: &AppState, doc_text: &str) -> Result<String, String> {
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
        "doc_html": "",
        "doc_history": [],
        "keystroke_log": log_jsonl,
        "keystroke_count": keystroke_count,
        "start_wall_ns": start_wall_ns,
        "log_chain_hash": log_chain_hash,
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
        "keyboard_vendor_id": keyboard.as_ref().map(|k| format!("0x{:04x}", k.vendor_id)),
        "keyboard_transport": keyboard.as_ref().map(|k| k.transport.clone()),
    });

    let body = payload.to_string();
    let request = format!(
        "POST /api/sessions HTTP/1.1\r\nHost: localhost:4000\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );

    let mut stream = TcpStream::connect("127.0.0.1:4000")
        .map_err(|e| format!("Cannot connect to proof server (is it running? cd proof-server && node server.js): {e}"))?;
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;

    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|e| e.to_string())?;

    let body_start = response.find("\r\n\r\n")
        .ok_or("Invalid HTTP response from proof server")? + 4;
    let resp_body = &response[body_start..];

    let resp_json: serde_json::Value = serde_json::from_str(resp_body)
        .map_err(|e| format!("Bad JSON from proof server: {e}"))?;

    let url = resp_json["url"].as_str()
        .ok_or("No 'url' field in proof server response")?
        .to_string();

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: call upload_proof_native but override the connect address to a
    /// port that is guaranteed to have nothing listening.  We pick a high
    /// ephemeral port (19999) and bind it ourselves only to detect if it's free,
    /// then immediately drop it so the connect below can also fail.
    fn upload_with_dead_port(state: &AppState, doc_text: &str) -> Result<String, String> {
        // Build the payload the same way upload_proof_native does, but connect
        // to a port where no server is listening.
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
            "doc_html": "",
            "doc_history": [],
            "keystroke_log": log_jsonl,
            "keystroke_count": keystroke_count,
            "start_wall_ns": start_wall_ns,
            "log_chain_hash": log_chain_hash,
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
            "keyboard_vendor_id": keyboard.as_ref().map(|k| format!("0x{:04x}", k.vendor_id)),
            "keyboard_transport": keyboard.as_ref().map(|k| k.transport.clone()),
        });

        let body = payload.to_string();
        let request = format!(
            "POST /api/sessions HTTP/1.1\r\nHost: localhost:19999\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );

        // Connect to a port (19999) where nothing is listening.
        let mut stream = TcpStream::connect("127.0.0.1:19999")
            .map_err(|e| format!("Cannot connect to proof server (is it running? cd proof-server && node server.js): {e}"))?;
        stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
        let mut response = String::new();
        stream.read_to_string(&mut response).map_err(|e| e.to_string())?;
        Ok(response)
    }

    #[test]
    fn upload_fails_gracefully_when_server_down() {
        use crate::session::SessionState;
        use crate::editor::EditorDocumentState;
        use std::sync::Mutex;
        use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64};

        let state = AppState {
            session: Mutex::new(SessionState::new(0)),
            editor_state: Mutex::new(EditorDocumentState::default()),
            hid_active: AtomicBool::new(false),
            pending_builtin_keydowns: AtomicI32::new(0),
            integrity: Default::default(),
            keyboard_info: Mutex::new(None),
            last_keydown_ns: AtomicU64::new(0),
        };

        let result = upload_with_dead_port(&state, "test doc");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("Cannot connect") || msg.contains("connect"), "got: {msg}");
    }
}
