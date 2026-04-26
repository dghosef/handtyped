use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
use tauri::Manager;

static SCREEN_CAPTURED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
pub fn is_screen_being_captured() -> bool {
    use std::process::Command;
    let output = Command::new("pgrep")
        .args(["-x", "screencapture"])
        .output();

    match output {
        Ok(o) => !o.stdout.is_empty(),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn is_screen_being_captured() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn start_screen_capture_detection<R: tauri::Runtime>(app_handle: tauri::AppHandle<R>) {
    use std::thread;
    use std::time::Duration;

    let app = app_handle.clone();
    thread::spawn(move || {
        let mut was_captured = false;
        loop {
            let now_captured = is_screen_being_captured();
            if now_captured != was_captured {
                SCREEN_CAPTURED.store(now_captured, Ordering::SeqCst);
                was_captured = now_captured;

                if now_captured {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                } else {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn start_screen_capture_detection<R: tauri::Runtime>(_: tauri::AppHandle<R>) {}

pub fn is_screen_capture_active() -> bool {
    SCREEN_CAPTURED.load(Ordering::SeqCst)
}