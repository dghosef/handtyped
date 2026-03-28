use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::menu::{HELP_SUBMENU_ID, Menu, MenuItem, PredefinedMenuItem};

pub mod integrity;
pub mod session;
pub mod hid;
pub mod commands;
pub mod bundle;
pub mod signing;

use session::{AppState, SessionState};

const HELP_GETTING_STARTED_ID: &str = "help.getting_started";
const HELP_SHORTCUTS_ID: &str = "help.shortcuts";
const HELP_MARKDOWN_ID: &str = "help.markdown";
const HELP_INPUT_MONITORING_ID: &str = "help.input_monitoring";

fn eval_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, script: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;

    if let Some(help_item) = menu.get(HELP_SUBMENU_ID) {
        if let Some(help_menu) = help_item.as_submenu() {
            help_menu.append(&PredefinedMenuItem::separator(app)?)?;
            help_menu.append(&MenuItem::with_id(
                app,
                HELP_GETTING_STARTED_ID,
                "Getting Started",
                true,
                None::<&str>,
            )?)?;
            help_menu.append(&MenuItem::with_id(
                app,
                HELP_SHORTCUTS_ID,
                "Keyboard Shortcuts",
                true,
                Some("Cmd+/"),
            )?)?;
            help_menu.append(&MenuItem::with_id(
                app,
                HELP_MARKDOWN_ID,
                "Markdown Mode Help",
                true,
                None::<&str>,
            )?)?;
            help_menu.append(&MenuItem::with_id(
                app,
                HELP_INPUT_MONITORING_ID,
                "Input Monitoring Setup",
                true,
                None::<&str>,
            )?)?;
        }
    }

    Ok(menu)
}

pub fn run() {
    // ── 1. Block debugger attachment immediately ─────────────────────────────
    integrity::deny_debugger_attach();

    // ── 2. Integrity checks ──────────────────────────────────────────────────
    let report = integrity::run_checks();

    // Hard abort on definitive runtime tampering indicators.
    // An attacker can bypass this by patching the binary — which is exactly why
    // the report is also signed into every session bundle for server-side rejection.
    if report.frida_detected {
        eprintln!("[humanproof] ABORT: Frida agent detected in process");
        std::process::exit(1);
    }
    if report.dylib_injection_detected {
        eprintln!("[humanproof] ABORT: injected dylib detected");
        std::process::exit(1);
    }
    if report.dyld_env_injection {
        eprintln!("[humanproof] ABORT: DYLD injection environment variable present");
        std::process::exit(1);
    }
    // In release builds a broken code signature means the binary has been tampered with.
    #[cfg(not(debug_assertions))]
    if !report.code_signing_valid {
        eprintln!("[humanproof] ABORT: code signature invalid");
        std::process::exit(1);
    }

    // ── 3. Build shared state ────────────────────────────────────────────────
    let start_mach = unsafe { hid::mach_absolute_time() };

    let state = Arc::new(AppState {
        session: Mutex::new(SessionState::new(start_mach)),
        hid_active: std::sync::atomic::AtomicBool::new(false),
        pending_builtin_keydowns: std::sync::atomic::AtomicI32::new(0),
        integrity: report,
        keyboard_info: Mutex::new(None),
        last_keydown_ns: std::sync::atomic::AtomicU64::new(0),
    });

    let state_for_hid = Arc::clone(&state);

    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            HELP_GETTING_STARTED_ID => eval_main_window(app, "window.__openHelpTopic?.('getting_started')"),
            HELP_SHORTCUTS_ID => eval_main_window(app, "window.__menuCmd?.('shortcuts')"),
            HELP_MARKDOWN_ID => eval_main_window(app, "window.__openHelpTopic?.('markdown')"),
            HELP_INPUT_MONITORING_ID => eval_main_window(app, "window.__openHelpTopic?.('input_monitoring')"),
            _ => {}
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(move |_app| {
            unsafe { hid::request_input_monitoring_access() };
            hid::start_hid_capture(state_for_hid);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::log_paste_event,
            commands::log_focus_loss_event,
            commands::get_keystroke_count,
            commands::get_hid_status,
            commands::consume_builtin_keydown,
            commands::open_input_monitoring_settings,
            commands::save_session_payload,
            commands::load_session_payload,
            commands::get_document_store_key,
            commands::export_bundle,
            commands::upload_proof,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
