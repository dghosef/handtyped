use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID};
use tauri::Manager;

pub mod bundle;
pub mod commands;
pub mod document;
pub mod editor;
pub mod hid;
pub mod integrity;
pub mod lockdown;
pub mod observability;
pub mod preview;
pub mod session;
pub mod signing;
pub mod upload;
pub mod vim;
pub mod wysiwyg;

use session::{AppState, SessionState};

const HELP_GETTING_STARTED_ID: &str = "help.getting_started";
const HELP_SHORTCUTS_ID: &str = "help.shortcuts";
const HELP_MARKDOWN_ID: &str = "help.markdown";
const HELP_INPUT_MONITORING_ID: &str = "help.input_monitoring";

const FILE_NEW_ID: &str = "file.new";
const FILE_OPEN_ID: &str = "file.open";
const FILE_SAVE_ID: &str = "file.save";
const FILE_SAVE_AS_ID: &str = "file.save_as";

fn eval_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, script: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;

    // Build File menu.
    let file_menu = Submenu::new(app, "File", true)?;
    file_menu.append(&MenuItem::with_id(
        app,
        FILE_NEW_ID,
        "New",
        true,
        Some("Cmd+N"),
    )?)?;
    file_menu.append(&MenuItem::with_id(
        app,
        FILE_OPEN_ID,
        "Open…",
        true,
        Some("Cmd+O"),
    )?)?;
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    file_menu.append(&MenuItem::with_id(
        app,
        FILE_SAVE_ID,
        "Save",
        true,
        Some("Cmd+S"),
    )?)?;
    file_menu.append(&MenuItem::with_id(
        app,
        FILE_SAVE_AS_ID,
        "Save As…",
        true,
        Some("Cmd+Shift+S"),
    )?)?;

    // Insert File menu at the beginning.
    menu.insert(&file_menu, 0)?;

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
    observability::install_panic_hook();

    // ── 1. Block debugger attachment immediately ─────────────────────────────
    integrity::deny_debugger_attach();

    // ── 2. Integrity checks ──────────────────────────────────────────────────
    let report = integrity::run_checks();

    // Hard abort on definitive runtime tampering indicators.
    // An attacker can bypass this by patching the binary — which is exactly why
    // the report is also signed into every session bundle for server-side rejection.
    if report.frida_detected {
        eprintln!("[handtyped] ABORT: Frida agent detected in process");
        std::process::exit(1);
    }
    if report.dylib_injection_detected {
        eprintln!("[handtyped] ABORT: injected dylib detected");
        std::process::exit(1);
    }
    if report.dyld_env_injection {
        eprintln!("[handtyped] ABORT: DYLD injection environment variable present");
        std::process::exit(1);
    }
    // In release builds a broken code signature means the binary has been tampered with.
    #[cfg(not(debug_assertions))]
    if !report.code_signing_valid {
        eprintln!("[handtyped] ABORT: code signature invalid");
        std::process::exit(1);
    }

    // ── 3. Build shared state ────────────────────────────────────────────────
    let start_mach = unsafe { hid::mach_absolute_time() };

    let state = Arc::new(AppState {
        session: Mutex::new(SessionState::new(start_mach)),
        editor_state: Mutex::new(
            editor::load_editor_state_from_disk()
                .ok()
                .flatten()
                .unwrap_or_default(),
        ),
        hid_active: std::sync::atomic::AtomicBool::new(false),
        builtin_keydown_timestamp: std::sync::atomic::AtomicU64::new(0),
        integrity: report,
        keyboard_info: Mutex::new(None),
        last_keydown_ns: std::sync::atomic::AtomicU64::new(0),
        observability: Mutex::new(observability::RuntimeObservability::load_from_disk()),
    });

    let state_for_hid = Arc::clone(&state);

    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            FILE_NEW_ID => eval_main_window(app, "window.__fileNew?.()"),
            FILE_OPEN_ID => eval_main_window(app, "window.__fileOpen?.()"),
            FILE_SAVE_ID => eval_main_window(app, "window.__fileSave?.()"),
            FILE_SAVE_AS_ID => eval_main_window(app, "window.__fileSaveAs?.()"),
            HELP_GETTING_STARTED_ID => {
                eval_main_window(app, "window.__openHelpTopic?.('getting_started')")
            }
            HELP_SHORTCUTS_ID => eval_main_window(app, "window.__menuCmd?.('shortcuts')"),
            HELP_MARKDOWN_ID => eval_main_window(app, "window.__openHelpTopic?.('markdown')"),
            HELP_INPUT_MONITORING_ID => {
                eval_main_window(app, "window.__openHelpTopic?.('input_monitoring')")
            }
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
            commands::load_editor_state,
            commands::save_editor_state,
            commands::open_document,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
