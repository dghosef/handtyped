use std::sync::{Arc, Mutex};

pub mod session;
pub mod hid;
pub mod commands;
pub mod bundle;
pub mod signing;

use session::{AppState, SessionState};

pub fn run() {
    let start_mach = unsafe { hid::mach_absolute_time() };

    let state = Arc::new(AppState {
        session: Mutex::new(SessionState::new(start_mach)),
    });

    let state_for_hid = Arc::clone(&state);
    hid::start_hid_capture(state_for_hid);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::log_paste_event,
            commands::log_focus_loss_event,
            commands::get_keystroke_count,
            commands::save_session,
            commands::export_bundle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
