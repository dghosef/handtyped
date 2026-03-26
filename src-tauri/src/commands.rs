use tauri::State;
use std::sync::Arc;
use crate::session::AppState;
use crate::bundle;

fn now_ns() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
}

#[tauri::command]
pub fn log_paste_event(_char_count: usize, _state: State<Arc<AppState>>) {}

#[tauri::command]
pub fn log_focus_loss_event(_duration_ms: u64, _state: State<Arc<AppState>>) {}

#[tauri::command]
pub fn get_keystroke_count(state: State<Arc<AppState>>) -> usize {
    state.session.lock().unwrap().keystroke_count()
}

#[tauri::command]
pub fn save_session(_state: State<Arc<AppState>>) -> Result<(), String> { Ok(()) }

#[tauri::command]
pub async fn export_bundle(
    _doc_text: String,
    _doc_html: String,
    _state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    Ok(String::new())
}
