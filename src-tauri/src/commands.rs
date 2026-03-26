use tauri::State;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use std::fs;
use crate::session::{AppState, ExtraEvent};
use crate::bundle;

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
}

fn session_dir(session_id: &str) -> std::path::PathBuf {
    let mut path = dirs_next::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    path.push("humanproof");
    path.push("sessions");
    path.push(session_id);
    path
}

#[tauri::command]
pub fn log_paste_event(char_count: usize, state: State<Arc<AppState>>) {
    let mut s = state.session.lock().unwrap();
    s.append_extra(ExtraEvent {
        t: now_ns(),
        kind: "paste".into(),
        char_count: Some(char_count),
        duration_ms: None,
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
    });
}

#[tauri::command]
pub fn get_keystroke_count(state: State<Arc<AppState>>) -> usize {
    state.session.lock().unwrap().keystroke_count()
}

#[tauri::command]
pub fn save_session(state: State<Arc<AppState>>) -> Result<(), String> {
    let s = state.session.lock().unwrap();
    let dir = session_dir(&s.session_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log_path = dir.join("keystroke-log.jsonl");
    fs::write(&log_path, s.to_jsonl()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn export_bundle(
    doc_text: String,
    doc_html: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let input = {
        let s = state.session.lock().unwrap();
        bundle::BundleInput {
            session_id: s.session_id.clone(),
            session_nonce: s.session_nonce.clone(),
            start_wall_ns: s.start_wall_ns,
            log_jsonl: s.to_jsonl(),
            keystroke_count: s.keystroke_count(),
        }
    };
    bundle::build_and_sign(input, doc_text, doc_html)
}
