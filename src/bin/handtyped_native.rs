use eframe::egui;
use handtyped_lib::document::{self, DocumentPayload};
use handtyped_lib::editor::{self, EditorDocumentState, EditorMode, TextChange};
use handtyped_lib::hid;
use handtyped_lib::integrity;
use handtyped_lib::observability;
use handtyped_lib::preview::{parse_markdown_for_preview, PreviewBlock};
use handtyped_lib::session::{AppState, SessionState};
use handtyped_lib::signing;
use handtyped_lib::wysiwyg::{MarkdownEditor, ModeColors};
use muda::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const EDITOR_WIDGET_ID: &str = "handtyped_md_editor";
static NEXT_TAB_ID: AtomicU64 = AtomicU64::new(1);

fn main() -> eframe::Result<()> {
    observability::install_panic_hook();
    integrity::deny_debugger_attach();
    let report = integrity::run_checks();
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
        pending_builtin_keydowns: std::sync::atomic::AtomicI32::new(0),
        integrity: report,
        keyboard_info: Mutex::new(None),
        last_keydown_ns: std::sync::atomic::AtomicU64::new(0),
        observability: Mutex::new(observability::RuntimeObservability::load_from_disk()),
    });

    unsafe { hid::request_input_monitoring_access() };
    hid::start_hid_capture(Arc::clone(&state));
    signing::prime_key_cache_in_background();

    let icon = eframe::icon_data::from_png_bytes(include_bytes!("../../icons/icon.png"))
        .expect("valid icon PNG");
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1200.0, 780.0])
            .with_title("Handtyped")
            .with_visible(false)
            .with_icon(std::sync::Arc::new(icon)),
        ..Default::default()
    };

    eframe::run_native(
        "Handtyped",
        options,
        Box::new(move |cc| {
            // Create menu bar after window is ready
            #[cfg(target_os = "macos")]
            {
                let _ = create_menu_bar();
            }
            Ok(Box::new(NativeEditorApp::new(cc, Arc::clone(&state))))
        }),
    )
}

/// What `persist()` should do depending on whether the document has a path.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
enum PersistAction {
    /// Document has a known path — save in-place.
    SaveToPath,
    /// New document, no path yet — must prompt the user for a filename.
    NeedFilename,
}

#[cfg(test)]
fn persist_action(current_path: Option<&std::path::Path>) -> PersistAction {
    if current_path.is_some() {
        PersistAction::SaveToPath
    } else {
        PersistAction::NeedFilename
    }
}

/// Menu actions dispatched from native macOS menu events.
#[derive(Debug, PartialEq, Eq)]
enum MenuAction {
    New,
    NewTab,
    Open,
    Save,
    SaveAs,
    CloseTab,
    NextTab,
    PreviousTab,
    Unknown,
}

/// Maps a muda menu event ID string to a `MenuAction`.
/// Extracted as a pure function so it can be unit-tested independently of the
/// macOS event loop.
fn menu_event_action(id: &str) -> MenuAction {
    match id {
        "file.new" => MenuAction::New,
        "file.new_tab" => MenuAction::NewTab,
        "file.open" => MenuAction::Open,
        "file.save" => MenuAction::Save,
        "file.save_as" => MenuAction::SaveAs,
        "file.close_tab" => MenuAction::CloseTab,
        "file.next_tab" => MenuAction::NextTab,
        "file.previous_tab" => MenuAction::PreviousTab,
        _ => MenuAction::Unknown,
    }
}

#[cfg(target_os = "macos")]
fn open_input_monitoring_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        .spawn();
}

#[cfg(not(target_os = "macos"))]
fn open_input_monitoring_settings() {}

#[cfg(target_os = "macos")]
fn create_menu_bar() {
    use muda::accelerator::{Accelerator, Code, Modifiers};

    // On macOS the first Submenu appended to Menu is the app-name menu (the
    // leftmost entry in the menu bar). We add an explicit app menu so that
    // "File" appears as its own distinct menu title rather than being consumed
    // by the app-name slot.
    //
    // All objects must live for the process lifetime: muda stores raw pointers
    // to String fields inside MenuItem/Submenu for macOS menu callbacks.
    // Dropping them early causes use-after-free when a keyboard shortcut fires.
    // Box::leak is intentional here.

    // ── App menu (shown as "Handtyped" in the menu bar) ─────────────────────
    let app_about = Box::new(PredefinedMenuItem::about(
        None,
        Some(AboutMetadata {
            credits: Some("Fingerprint by purplestudio from Noun Project (CC BY 3.0)".to_string()),
            ..Default::default()
        }),
    ));
    let app_sep = Box::new(PredefinedMenuItem::separator());
    let app_quit = Box::new(PredefinedMenuItem::quit(None));

    let app_menu = Box::new(Submenu::new("Handtyped", true));
    app_menu.append(app_about.as_ref()).unwrap();
    app_menu.append(app_sep.as_ref()).unwrap();
    app_menu.append(app_quit.as_ref()).unwrap();

    // ── File menu ─────────────────────────────────────────────────────────────
    let item_new = Box::new(MenuItem::with_id(
        "file.new",
        "New",
        true,
        Some(Accelerator::new(Some(Modifiers::META), Code::KeyN)),
    ));
    let item_new_tab = Box::new(MenuItem::with_id(
        "file.new_tab",
        "New Tab",
        true,
        Some(Accelerator::new(Some(Modifiers::META), Code::KeyT)),
    ));
    let item_open = Box::new(MenuItem::with_id(
        "file.open",
        "Open…",
        true,
        Some(Accelerator::new(Some(Modifiers::META), Code::KeyO)),
    ));
    let file_sep = Box::new(PredefinedMenuItem::separator());
    let item_close_tab = Box::new(MenuItem::with_id(
        "file.close_tab",
        "Close Tab",
        true,
        Some(Accelerator::new(Some(Modifiers::META), Code::KeyW)),
    ));
    let item_save = Box::new(MenuItem::with_id(
        "file.save",
        "Save",
        true,
        Some(Accelerator::new(Some(Modifiers::META), Code::KeyS)),
    ));
    let item_save_as = Box::new(MenuItem::with_id(
        "file.save_as",
        "Save As…",
        true,
        Some(Accelerator::new(
            Some(Modifiers::META | Modifiers::SHIFT),
            Code::KeyS,
        )),
    ));
    let item_previous_tab = Box::new(MenuItem::with_id(
        "file.previous_tab",
        "Previous Tab",
        true,
        Some(Accelerator::new(
            Some(Modifiers::META | Modifiers::SHIFT),
            Code::BracketLeft,
        )),
    ));
    let item_next_tab = Box::new(MenuItem::with_id(
        "file.next_tab",
        "Next Tab",
        true,
        Some(Accelerator::new(
            Some(Modifiers::META | Modifiers::SHIFT),
            Code::BracketRight,
        )),
    ));

    let file_menu = Box::new(Submenu::new("File", true));
    file_menu.append(item_new.as_ref()).unwrap();
    file_menu.append(item_new_tab.as_ref()).unwrap();
    file_menu.append(item_open.as_ref()).unwrap();
    file_menu.append(file_sep.as_ref()).unwrap();
    file_menu.append(item_close_tab.as_ref()).unwrap();
    file_menu.append(item_save.as_ref()).unwrap();
    file_menu.append(item_save_as.as_ref()).unwrap();
    file_menu.append(item_previous_tab.as_ref()).unwrap();
    file_menu.append(item_next_tab.as_ref()).unwrap();

    // ── Assemble and attach ───────────────────────────────────────────────────
    let menu = Box::new(Menu::new());
    menu.append(app_menu.as_ref()).unwrap(); // slot 0 → app-name menu
    menu.append(file_menu.as_ref()).unwrap(); // slot 1 → "File"
    menu.init_for_nsapp();

    Box::leak(app_about);
    Box::leak(app_sep);
    Box::leak(app_quit);
    Box::leak(app_menu);
    Box::leak(item_new);
    Box::leak(item_new_tab);
    Box::leak(item_open);
    Box::leak(file_sep);
    Box::leak(item_close_tab);
    Box::leak(item_save);
    Box::leak(item_save_as);
    Box::leak(item_previous_tab);
    Box::leak(item_next_tab);
    Box::leak(file_menu);
    Box::leak(menu);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every ID registered in create_menu_bar must map to a non-Unknown action.
    /// This is the regression test for the Cmd+Shift+S crash: before the fix,
    /// menu items were dropped at end of create_menu_bar (use-after-free).
    /// After the fix the items are leaked, but the routing must still be correct.
    #[test]
    fn all_registered_menu_ids_are_routed() {
        // Keep this list in sync with MENU_ITEM_IDS / create_menu_bar.
        let registered = [
            "file.new",
            "file.new_tab",
            "file.open",
            "file.close_tab",
            "file.save",
            "file.save_as",
            "file.previous_tab",
            "file.next_tab",
        ];
        for id in &registered {
            assert_ne!(
                menu_event_action(id),
                MenuAction::Unknown,
                "menu id '{}' is registered in create_menu_bar but not handled in menu_event_action — \
                 this means pressing its keyboard shortcut would silently do nothing",
                id
            );
        }
    }

    #[test]
    fn menu_ids_map_to_correct_actions() {
        assert_eq!(menu_event_action("file.new"), MenuAction::New);
        assert_eq!(menu_event_action("file.new_tab"), MenuAction::NewTab);
        assert_eq!(menu_event_action("file.open"), MenuAction::Open);
        assert_eq!(menu_event_action("file.close_tab"), MenuAction::CloseTab);
        assert_eq!(menu_event_action("file.save"), MenuAction::Save);
        assert_eq!(menu_event_action("file.save_as"), MenuAction::SaveAs);
        assert_eq!(
            menu_event_action("file.previous_tab"),
            MenuAction::PreviousTab
        );
        assert_eq!(menu_event_action("file.next_tab"), MenuAction::NextTab);
        assert_eq!(menu_event_action("file.export"), MenuAction::Unknown);
        assert_eq!(menu_event_action(""), MenuAction::Unknown);
    }

    /// Confirm save_as ID is not accidentally mapped to save (easy typo).
    #[test]
    fn save_and_save_as_are_distinct() {
        assert_ne!(
            menu_event_action("file.save"),
            menu_event_action("file.save_as")
        );
    }

    #[test]
    fn preview_links_use_explicit_accent_color() {
        assert_eq!(
            preview_link_color(),
            egui::Color32::from_rgb(0x26, 0x8b, 0xd2)
        );
    }

    #[test]
    fn preview_links_open_in_new_tab() {
        let target = preview_link_target("https://example.com");
        assert_eq!(target.url, "https://example.com");
        assert!(target.new_tab);
    }

    #[test]
    fn preview_segments_only_become_clickable_when_they_have_links() {
        assert!(preview_segment_is_clickable(Some("https://example.com")));
        assert!(!preview_segment_is_clickable(None));
    }

    #[test]
    fn save_as_completion_updates_origin_tab_not_whatever_is_active() {
        let mut tabs = vec![
            DocumentTab {
                tab_id: 1,
                path: PathBuf::from("/tmp/original.ht"),
                editor_state: EditorDocumentState {
                    markdown: "scratch draft".into(),
                    ..EditorDocumentState::default()
                },
                persisted_markdown: "".into(),
                doc_history: default_doc_history("scratch draft"),
                replay_origin_wall_ms: 1,
                replay_url: None,
                published_history_len: None,
                theme: Theme::Gruvbox,
                pane_mode: PaneMode::Split,
                doc_is_writable: true,
            },
            DocumentTab {
                tab_id: 2,
                path: PathBuf::from("/tmp/other.ht"),
                editor_state: EditorDocumentState {
                    markdown: "other tab".into(),
                    ..EditorDocumentState::default()
                },
                persisted_markdown: "other tab".into(),
                doc_history: default_doc_history("other tab"),
                replay_origin_wall_ms: 2,
                replay_url: None,
                published_history_len: None,
                theme: Theme::Nord,
                pane_mode: PaneMode::Source,
                doc_is_writable: true,
            },
        ];

        let saved_path = PathBuf::from("/tmp/saved.ht");
        let snapshot = EditorDocumentState {
            markdown: "scratch draft".into(),
            ..EditorDocumentState::default()
        };
        let origin_tab_id = tabs[0].tab_id;

        let updated = apply_save_as_result(
            &mut tabs,
            Some(1),
            Some(origin_tab_id),
            saved_path.clone(),
            "scratch draft".into(),
            snapshot,
            Theme::Catppuccin,
            PaneMode::Source,
            true,
        );

        assert_eq!(updated, Some(0));
        assert_eq!(tabs[0].path, saved_path);
        assert_eq!(tabs[0].editor_state.markdown, "scratch draft");
        assert_eq!(tabs[0].theme, Theme::Catppuccin);
        assert!(matches!(tabs[0].pane_mode, PaneMode::Source));
        assert_eq!(tabs[1].path, PathBuf::from("/tmp/other.ht"));
        assert_eq!(tabs[1].editor_state.markdown, "other tab");
        assert_eq!(tabs[1].theme, Theme::Nord);
        assert!(matches!(tabs[1].pane_mode, PaneMode::Source));
    }

    #[test]
    fn save_as_completion_ignores_tab_index_shifts_and_leaves_other_tabs_alone() {
        let mut tabs = vec![
            DocumentTab {
                tab_id: 1,
                path: PathBuf::from("/tmp/original.ht"),
                editor_state: EditorDocumentState {
                    markdown: "draft one".into(),
                    ..EditorDocumentState::default()
                },
                persisted_markdown: "draft one".into(),
                doc_history: default_doc_history("draft one"),
                replay_origin_wall_ms: 1,
                replay_url: None,
                published_history_len: None,
                theme: Theme::Gruvbox,
                pane_mode: PaneMode::Split,
                doc_is_writable: true,
            },
            DocumentTab {
                tab_id: 2,
                path: PathBuf::from("/tmp/other.ht"),
                editor_state: EditorDocumentState {
                    markdown: "other tab".into(),
                    ..EditorDocumentState::default()
                },
                persisted_markdown: "other tab".into(),
                doc_history: default_doc_history("other tab"),
                replay_origin_wall_ms: 2,
                replay_url: None,
                published_history_len: None,
                theme: Theme::Nord,
                pane_mode: PaneMode::Source,
                doc_is_writable: true,
            },
        ];

        let origin_tab_id = tabs[0].tab_id;
        tabs.remove(0);

        let saved_path = PathBuf::from("/tmp/saved.ht");
        let snapshot = EditorDocumentState {
            markdown: "draft one".into(),
            ..EditorDocumentState::default()
        };

        let updated = apply_save_as_result(
            &mut tabs,
            Some(0),
            Some(origin_tab_id),
            saved_path.clone(),
            "draft one".into(),
            snapshot,
            Theme::Catppuccin,
            PaneMode::Source,
            true,
        );

        assert_eq!(updated, Some(1));
        assert_eq!(tabs[0].path, PathBuf::from("/tmp/other.ht"));
        assert_eq!(tabs[0].editor_state.markdown, "other tab");
        assert_eq!(tabs[0].theme, Theme::Nord);
        assert_eq!(tabs[1].path, saved_path);
        assert_eq!(tabs[1].editor_state.markdown, "draft one");
        assert_eq!(tabs[1].theme, Theme::Catppuccin);
    }

    /// Cmd+S on a new document (no path) must prompt for a filename, not
    /// silently save to the legacy editor-state path.
    #[test]
    fn save_with_no_path_needs_filename() {
        assert_eq!(
            persist_action(None),
            PersistAction::NeedFilename,
            "Cmd+S on a new document must prompt for a filename"
        );
    }

    /// Cmd+S on an existing document (path known) must save in-place.
    #[test]
    fn save_with_known_path_saves_in_place() {
        let path = std::path::PathBuf::from("/tmp/test.ht");
        assert_eq!(
            persist_action(Some(&path)),
            PersistAction::SaveToPath,
            "Cmd+S on an opened document must save in-place"
        );
    }

    #[test]
    fn replay_upload_required_without_cached_url() {
        assert!(replay_upload_required(None, None, 1));
    }

    #[test]
    fn replay_upload_required_when_history_has_changed() {
        assert!(replay_upload_required(
            Some("http://localhost/abc"),
            Some(1),
            2
        ));
    }

    #[test]
    fn replay_upload_not_required_when_cache_matches_history() {
        assert!(!replay_upload_required(
            Some("http://localhost/abc"),
            Some(3),
            3,
        ));
    }

    #[test]
    fn replay_open_plan_prefers_fresh_upload_over_stale_cached_replay() {
        assert_eq!(
            replay_open_plan(Some("http://localhost/stale"), Some(1), 2),
            ReplayOpenPlan::UploadAndOpenAfterReady
        );
    }

    #[test]
    fn replay_open_plan_uses_cached_replay_when_history_matches() {
        assert_eq!(
            replay_open_plan(Some("http://localhost/current"), Some(3), 3),
            ReplayOpenPlan::OpenCachedReplay
        );
    }

    #[test]
    fn replay_upload_completion_ignores_missing_origin_tab_and_leaves_others_untouched() {
        let mut tabs = vec![
            DocumentTab {
                tab_id: 11,
                path: PathBuf::from("/tmp/original.ht"),
                editor_state: EditorDocumentState {
                    markdown: "draft one".into(),
                    ..EditorDocumentState::default()
                },
                persisted_markdown: "draft one".into(),
                doc_history: default_doc_history("draft one"),
                replay_origin_wall_ms: 1,
                replay_url: None,
                published_history_len: None,
                theme: Theme::Gruvbox,
                pane_mode: PaneMode::Split,
                doc_is_writable: true,
            },
            DocumentTab {
                tab_id: 22,
                path: PathBuf::from("/tmp/other.ht"),
                editor_state: EditorDocumentState {
                    markdown: "other tab".into(),
                    ..EditorDocumentState::default()
                },
                persisted_markdown: "other tab".into(),
                doc_history: default_doc_history("other tab"),
                replay_origin_wall_ms: 2,
                replay_url: None,
                published_history_len: None,
                theme: Theme::Nord,
                pane_mode: PaneMode::Source,
                doc_is_writable: true,
            },
        ];

        let origin_tab_id = tabs[0].tab_id;
        tabs.remove(0);

        let updated = apply_replay_upload_result(
            &mut tabs,
            origin_tab_id,
            "https://replay.handtyped.app/abc123".into(),
            9,
        );

        assert_eq!(updated, None);
        assert_eq!(tabs[0].replay_url, None);
        assert_eq!(tabs[0].published_history_len, None);
        assert_eq!(tabs[0].path, PathBuf::from("/tmp/other.ht"));
        assert_eq!(tabs[0].editor_state.markdown, "other tab");
    }

    #[test]
    fn replay_origin_resumes_from_last_saved_history_point() {
        assert_eq!(replay_origin_wall_ms_for(5_000, Some(1_250)), 3_750);
    }

    #[test]
    fn replay_origin_starts_at_now_without_saved_history() {
        assert_eq!(replay_origin_wall_ms_for(5_000, None), 5_000);
    }

    #[test]
    fn vim_toggle_requests_editor_focus() {
        let mut vim_enabled = false;
        let mut focus_editor_next_frame = false;

        toggle_vim_and_request_editor_focus(&mut vim_enabled, &mut focus_editor_next_frame);

        assert!(vim_enabled);
        assert!(focus_editor_next_frame);
    }

    #[test]
    fn pane_toggle_requests_editor_focus() {
        let mut pane_mode = PaneMode::Split;
        let mut focus_editor_next_frame = false;

        toggle_pane_mode_and_request_editor_focus(&mut pane_mode, &mut focus_editor_next_frame);

        assert!(matches!(pane_mode, PaneMode::Source));
        assert!(focus_editor_next_frame);
    }

    #[test]
    fn theme_change_requests_editor_focus() {
        let mut focus_editor_next_frame = false;

        set_theme_and_request_editor_focus(true, &mut focus_editor_next_frame);

        assert!(focus_editor_next_frame);
    }

    #[test]
    fn missing_theme_defaults_to_gruvbox_instead_of_weird_fallback() {
        assert!(matches!(
            Theme::from_storage_key(None),
            Theme::Gruvbox
        ));
    }

    #[test]
    fn unknown_theme_defaults_to_gruvbox_instead_of_weird_fallback() {
        assert!(matches!(
            Theme::from_storage_key(Some("totally_not_a_real_theme")),
            Theme::Gruvbox
        ));
    }

    #[test]
    fn schedule_editor_focus_marks_next_frame() {
        let mut focus_editor_next_frame = false;
        schedule_editor_focus(&mut focus_editor_next_frame);
        assert!(focus_editor_next_frame);
    }

    #[test]
    fn editor_focus_request_reaches_first_editor_frame() {
        let ctx = egui::Context::default();
        request_editor_focus(&ctx);

        let mut editor = MarkdownEditor::new("hello");
        let raw = egui::RawInput::default();
        let _ = ctx.run(raw, |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let _ = editor.show(ui, true);
            });
        });

        assert!(
            ctx.memory(|mem| mem.has_focus(egui::Id::new(EDITOR_WIDGET_ID))),
            "the editor must receive focus on the first frame after opening a document"
        );
    }

    #[test]
    fn startup_window_stays_hidden_while_input_monitoring_is_unknown() {
        assert!(!NativeEditorApp::should_reveal_startup_window_for_access(
            hid::InputMonitoringAccess::Unknown
        ));
    }

    #[test]
    fn startup_window_stays_hidden_when_input_monitoring_is_denied() {
        assert!(!NativeEditorApp::should_reveal_startup_window_for_access(
            hid::InputMonitoringAccess::Denied
        ));
    }

    #[test]
    fn startup_window_reveals_only_when_input_monitoring_is_granted() {
        assert!(NativeEditorApp::should_reveal_startup_window_for_access(
            hid::InputMonitoringAccess::Granted
        ));
    }

    #[test]
    fn startup_hidden_blocks_input_monitoring_ui_until_granted() {
        assert!(NativeEditorApp::should_block_startup_ui_until_permission_resolves(
            true,
            hid::InputMonitoringAccess::Unknown,
        ));
        assert!(NativeEditorApp::should_block_startup_ui_until_permission_resolves(
            true,
            hid::InputMonitoringAccess::Denied,
        ));
        assert!(!NativeEditorApp::should_block_startup_ui_until_permission_resolves(
            true,
            hid::InputMonitoringAccess::Granted,
        ));
        assert!(!NativeEditorApp::should_block_startup_ui_until_permission_resolves(
            false,
            hid::InputMonitoringAccess::Unknown,
        ));
    }

    #[test]
    fn document_autosave_requires_real_document_path() {
        assert!(!should_autosave_document(
            None,
            "draft",
            "",
            LaunchScreen::Editor,
        ));
    }

    #[test]
    fn document_autosave_disabled_on_start_screen() {
        let path = std::path::Path::new("/tmp/example.ht");
        assert!(!should_autosave_document(
            Some(path),
            "changed",
            "",
            LaunchScreen::Start,
        ));
    }

    #[test]
    fn document_autosave_enabled_for_open_document_changes() {
        let path = std::path::Path::new("/tmp/example.ht");
        assert!(should_autosave_document(
            Some(path),
            "changed",
            "",
            LaunchScreen::Editor,
        ));
    }

    #[test]
    fn launcher_clicking_active_recent_file_reopens_editor() {
        assert!(
            !should_skip_tab_reload(Some(0), 0, LaunchScreen::Start),
            "the launcher should re-enter the editor even if the selected recent file is already the active tab"
        );
        assert!(should_skip_tab_reload(Some(0), 0, LaunchScreen::Editor));
    }

    #[test]
    fn launcher_returns_to_prior_active_tab_when_closed() {
        assert_eq!(launcher_return_index(Some(2), None, 3), Some(2));
        assert_eq!(launcher_return_index(None, Some(1), 3), Some(1));
        assert_eq!(launcher_return_index(None, None, 3), Some(2));
        assert_eq!(launcher_return_index(Some(4), None, 3), Some(2));
        assert_eq!(launcher_return_index(None, None, 0), None);
    }

    #[test]
    fn startup_recent_file_path_skips_missing_entries_and_picks_first_existing() {
        use std::fs;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let missing = dir.path().join("missing.ht");
        let first = dir.path().join("first.ht");
        let second = dir.path().join("second.ht");
        fs::write(&first, "one").unwrap();
        fs::write(&second, "two").unwrap();

        let selected = startup_recent_file_path(&[missing.clone(), first.clone(), second.clone()]);

        assert_eq!(selected, Some(first));
    }

    #[test]
    fn recent_files_show_named_unsaved_open_documents() {
        let unsaved = PathBuf::from("/tmp/blog1.ht");
        let tabs = vec![DocumentTab {
            tab_id: 1,
            path: unsaved.clone(),
            editor_state: EditorDocumentState::default(),
            persisted_markdown: String::new(),
            doc_history: default_doc_history(""),
            replay_origin_wall_ms: 0,
            replay_url: None,
            published_history_len: None,
            theme: Theme::Gruvbox,
            pane_mode: PaneMode::Split,
            doc_is_writable: true,
        }];

        assert!(
            should_show_recent_file(&unsaved, &tabs),
            "a named document that is currently open should still appear in Recent Files before its first save"
        );
    }

    #[test]
    fn recent_files_hide_missing_paths_that_are_not_open() {
        let missing = PathBuf::from("/tmp/missing-blog1.ht");

        assert!(
            !should_show_recent_file(&missing, &[]),
            "stale missing paths should still be pruned from Recent Files"
        );
    }

    #[test]
    fn path_is_open_in_tabs_matches_equivalent_open_document_paths() {
        let path = PathBuf::from("/tmp/blog1.ht");
        let tabs = vec![DocumentTab {
            tab_id: 1,
            path: path.clone(),
            editor_state: EditorDocumentState::default(),
            persisted_markdown: String::new(),
            doc_history: default_doc_history(""),
            replay_origin_wall_ms: 0,
            replay_url: None,
            published_history_len: None,
            theme: Theme::Gruvbox,
            pane_mode: PaneMode::Split,
            doc_is_writable: true,
        }];

        assert!(path_is_open_in_tabs(&path, &tabs));
    }

    #[test]
    fn history_delta_entry_captures_simple_insert() {
        let delta = build_history_delta_entry("abc", "abXc", 42).unwrap();
        assert_eq!(delta["t"], 42);
        assert_eq!(delta["pos"], 2);
        assert_eq!(delta["del"], "");
        assert_eq!(delta["ins"], "X");
    }

    #[test]
    fn history_delta_entry_captures_replace_span() {
        let delta = build_history_delta_entry("hello world", "hello rust", 99).unwrap();
        assert_eq!(delta["t"], 99);
        assert_eq!(delta["pos"], 6);
        assert_eq!(delta["del"], "world");
        assert_eq!(delta["ins"], "rust");
    }

    #[test]
    fn same_openable_path_treats_symlink_and_canonical_path_as_the_same_file() {
        use std::fs;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let real_path = dir.path().join("document.ht");
        fs::write(&real_path, "hello").unwrap();

        #[cfg(unix)]
        let alias_path = {
            use std::os::unix::fs::symlink;
            let alias = dir.path().join("alias.ht");
            symlink(&real_path, &alias).unwrap();
            alias
        };

        #[cfg(not(unix))]
        let alias_path = std::fs::canonicalize(&real_path).unwrap();

        assert!(same_openable_path(&real_path, &alias_path));
        assert!(same_openable_path(&alias_path, &real_path));
    }
}

// ── Theme ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Theme {
    // Dark
    Gruvbox,
    SolarizedDark,
    Nord,
    Dracula,
    Everforest,
    Catppuccin,
    TokyoNight,
    // Light
    RosyPaper,
    SolarizedLight,
    GithubLight,
    Latte, // Catppuccin Latte
    OneLight,
}

impl Theme {
    fn label(self) -> &'static str {
        match self {
            Theme::Gruvbox => "Gruvbox",
            Theme::SolarizedDark => "Solarized Dark",
            Theme::Nord => "Nord",
            Theme::Dracula => "Dracula",
            Theme::Everforest => "Everforest",
            Theme::Catppuccin => "Catppuccin",
            Theme::TokyoNight => "Tokyo Night",
            Theme::RosyPaper => "Rosy Paper",
            Theme::SolarizedLight => "Solarized Light",
            Theme::GithubLight => "GitHub Light",
            Theme::Latte => "Catppuccin Latte",
            Theme::OneLight => "One Light",
        }
    }

    fn storage_key(self) -> &'static str {
        match self {
            Theme::Gruvbox => "gruvbox",
            Theme::SolarizedDark => "solarized_dark",
            Theme::Nord => "nord",
            Theme::Dracula => "dracula",
            Theme::Everforest => "everforest",
            Theme::Catppuccin => "catppuccin",
            Theme::TokyoNight => "tokyo_night",
            Theme::RosyPaper => "rosy_paper",
            Theme::SolarizedLight => "solarized_light",
            Theme::GithubLight => "github_light",
            Theme::Latte => "latte",
            Theme::OneLight => "one_light",
        }
    }

    fn from_storage_key(value: Option<&str>) -> Self {
        match value.unwrap_or_default() {
            "solarized_dark" => Theme::SolarizedDark,
            "nord" => Theme::Nord,
            "dracula" => Theme::Dracula,
            "everforest" => Theme::Everforest,
            "catppuccin" => Theme::Catppuccin,
            "tokyo_night" => Theme::TokyoNight,
            "rosy_paper" => Theme::RosyPaper,
            "solarized_light" => Theme::SolarizedLight,
            "github_light" => Theme::GithubLight,
            "latte" => Theme::Latte,
            "one_light" => Theme::OneLight,
            _ => Theme::Gruvbox,
        }
    }

    fn all() -> &'static [Theme] {
        &[
            Theme::Gruvbox,
            Theme::SolarizedDark,
            Theme::Nord,
            Theme::Dracula,
            Theme::Everforest,
            Theme::Catppuccin,
            Theme::TokyoNight,
            Theme::RosyPaper,
            Theme::SolarizedLight,
            Theme::GithubLight,
            Theme::Latte,
            Theme::OneLight,
        ]
    }

    fn mode_colors(self) -> ModeColors {
        let dark = egui::Color32::from_rgb(0x10, 0x10, 0x10);
        match self {
            Theme::Gruvbox => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x45, 0x85, 0x88), // gruvbox blue
                insert_bg: egui::Color32::from_rgb(0xb8, 0xbb, 0x26), // gruvbox bright-green
                visual_bg: egui::Color32::from_rgb(0xfa, 0xbd, 0x2f), // gruvbox bright-yellow
                command_bg: egui::Color32::from_rgb(0xd3, 0x86, 0x9b), // gruvbox bright-purple
                pill_fg: dark,
            },
            Theme::SolarizedDark => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x2a, 0xa1, 0x98), // cyan
                insert_bg: egui::Color32::from_rgb(0x85, 0x99, 0x00), // green
                visual_bg: egui::Color32::from_rgb(0xb5, 0x89, 0x00), // yellow
                command_bg: egui::Color32::from_rgb(0x6c, 0x71, 0xc4), // violet
                pill_fg: dark,
            },
            Theme::Nord => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x88, 0xc0, 0xd0), // frost cyan
                insert_bg: egui::Color32::from_rgb(0xa3, 0xbe, 0x8c), // aurora green
                visual_bg: egui::Color32::from_rgb(0xeb, 0xcb, 0x8b), // aurora yellow
                command_bg: egui::Color32::from_rgb(0xb4, 0x8e, 0xad), // aurora purple
                pill_fg: dark,
            },
            Theme::Dracula => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x8b, 0xe9, 0xfd), // cyan
                insert_bg: egui::Color32::from_rgb(0x50, 0xfa, 0x7b), // green
                visual_bg: egui::Color32::from_rgb(0xf1, 0xfa, 0x8c), // yellow
                command_bg: egui::Color32::from_rgb(0xff, 0x79, 0xc6), // pink
                pill_fg: dark,
            },
            Theme::Everforest => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x7f, 0xbb, 0xa3),
                insert_bg: egui::Color32::from_rgb(0xa7, 0xc0, 0x80),
                visual_bg: egui::Color32::from_rgb(0xdb, 0xbc, 0x7f),
                command_bg: egui::Color32::from_rgb(0xd6, 0x99, 0xb6),
                pill_fg: dark,
            },
            Theme::Catppuccin => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x89, 0xb4, 0xfa),
                insert_bg: egui::Color32::from_rgb(0xa6, 0xe3, 0xa1),
                visual_bg: egui::Color32::from_rgb(0xf9, 0xe2, 0xaf),
                command_bg: egui::Color32::from_rgb(0xf5, 0xc2, 0xe7),
                pill_fg: dark,
            },
            Theme::TokyoNight => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x7a, 0xa2, 0xf7),
                insert_bg: egui::Color32::from_rgb(0x9e, 0xce, 0x6a),
                visual_bg: egui::Color32::from_rgb(0xe0, 0xaf, 0x68),
                command_bg: egui::Color32::from_rgb(0xbb, 0x9a, 0xf7),
                pill_fg: dark,
            },
            Theme::RosyPaper => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x8f, 0x5c, 0x5c),
                insert_bg: egui::Color32::from_rgb(0x7b, 0x9e, 0x89),
                visual_bg: egui::Color32::from_rgb(0xc6, 0x9c, 0x6d),
                command_bg: egui::Color32::from_rgb(0xb2, 0x78, 0x8f),
                pill_fg: dark,
            },
            Theme::SolarizedLight => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x26, 0x8b, 0xd2), // blue
                insert_bg: egui::Color32::from_rgb(0x85, 0x99, 0x00), // green
                visual_bg: egui::Color32::from_rgb(0xb5, 0x89, 0x00), // yellow
                command_bg: egui::Color32::from_rgb(0x6c, 0x71, 0xc4), // violet
                pill_fg: egui::Color32::from_rgb(0xfd, 0xf6, 0xe3),
            },
            Theme::GithubLight => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x02, 0x69, 0xd6), // blue
                insert_bg: egui::Color32::from_rgb(0x1a, 0x7f, 0x37), // green
                visual_bg: egui::Color32::from_rgb(0xbf, 0x8b, 0x00), // yellow
                command_bg: egui::Color32::from_rgb(0x8a, 0x3f, 0xc4), // purple
                pill_fg: egui::Color32::WHITE,
            },
            Theme::Latte => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x1e, 0x66, 0xf5), // blue
                insert_bg: egui::Color32::from_rgb(0x40, 0xa0, 0x2b), // green
                visual_bg: egui::Color32::from_rgb(0xdf, 0x8e, 0x1d), // yellow
                command_bg: egui::Color32::from_rgb(0x8e, 0x39, 0xec), // mauve
                pill_fg: egui::Color32::WHITE,
            },
            Theme::OneLight => ModeColors {
                normal_bg: egui::Color32::from_rgb(0x40, 0x78, 0xf2), // blue
                insert_bg: egui::Color32::from_rgb(0x50, 0xa1, 0x4f), // green
                visual_bg: egui::Color32::from_rgb(0xc1, 0x88, 0x01), // gold
                command_bg: egui::Color32::from_rgb(0xa6, 0x26, 0xa4), // purple
                pill_fg: egui::Color32::WHITE,
            },
        }
    }

    /// Returns (success_color, error_color, status_dim_color, publish_button_color)
    fn ui_colors(self) -> (egui::Color32, egui::Color32, egui::Color32, egui::Color32) {
        match self {
            Theme::Gruvbox => (
                egui::Color32::from_rgb(0xb8, 0xbb, 0x26), // bright-green
                egui::Color32::from_rgb(0xfb, 0x49, 0x34), // bright-red
                egui::Color32::from_rgb(0xa8, 0x99, 0x84), // fg4
                egui::Color32::from_rgb(0x45, 0x85, 0x88), // blue
            ),
            Theme::SolarizedDark => (
                egui::Color32::from_rgb(0x85, 0x99, 0x00), // green
                egui::Color32::from_rgb(0xdc, 0x32, 0x2f), // red
                egui::Color32::from_rgb(0x65, 0x7b, 0x83), // base00
                egui::Color32::from_rgb(0x26, 0x8b, 0xd2), // blue
            ),
            Theme::Nord => (
                egui::Color32::from_rgb(0xa3, 0xbe, 0x8c), // aurora green
                egui::Color32::from_rgb(0xbf, 0x61, 0x6a), // aurora red
                egui::Color32::from_rgb(0x4c, 0x56, 0x6a), // polar night 4
                egui::Color32::from_rgb(0x5e, 0x81, 0xac), // frost blue
            ),
            Theme::Dracula => (
                egui::Color32::from_rgb(0x50, 0xfa, 0x7b), // green
                egui::Color32::from_rgb(0xff, 0x55, 0x55), // red
                egui::Color32::from_rgb(0x62, 0x72, 0xa4), // comment
                egui::Color32::from_rgb(0xbd, 0x93, 0xf9), // purple
            ),
            Theme::Everforest => (
                egui::Color32::from_rgb(0xa7, 0xc0, 0x80),
                egui::Color32::from_rgb(0xe6, 0x7e, 0x80),
                egui::Color32::from_rgb(0x85, 0x92, 0x89),
                egui::Color32::from_rgb(0x7f, 0xbb, 0xa3),
            ),
            Theme::Catppuccin => (
                egui::Color32::from_rgb(0xa6, 0xe3, 0xa1),
                egui::Color32::from_rgb(0xf3, 0x8b, 0xa8),
                egui::Color32::from_rgb(0x93, 0x9a, 0xb7),
                egui::Color32::from_rgb(0x89, 0xb4, 0xfa),
            ),
            Theme::TokyoNight => (
                egui::Color32::from_rgb(0x9e, 0xce, 0x6a),
                egui::Color32::from_rgb(0xf7, 0x76, 0x8e),
                egui::Color32::from_rgb(0x56, 0x5f, 0x89),
                egui::Color32::from_rgb(0x7a, 0xa2, 0xf7),
            ),
            Theme::RosyPaper => (
                egui::Color32::from_rgb(0x2f, 0x7d, 0x5b),
                egui::Color32::from_rgb(0xa1, 0x3a, 0x3a),
                egui::Color32::from_rgb(0x6b, 0x55, 0x4d),
                egui::Color32::from_rgb(0x8f, 0x5c, 0x5c),
            ),
            Theme::SolarizedLight => (
                egui::Color32::from_rgb(0x85, 0x99, 0x00), // green
                egui::Color32::from_rgb(0xdc, 0x32, 0x2f), // red
                egui::Color32::from_rgb(0x93, 0xa1, 0xa1), // base1 (dim)
                egui::Color32::from_rgb(0x26, 0x8b, 0xd2), // blue
            ),
            Theme::GithubLight => (
                egui::Color32::from_rgb(0x1a, 0x7f, 0x37), // green
                egui::Color32::from_rgb(0xcf, 0x22, 0x2e), // red
                egui::Color32::from_rgb(0x65, 0x6d, 0x76), // muted
                egui::Color32::from_rgb(0x02, 0x69, 0xd6), // blue
            ),
            Theme::Latte => (
                egui::Color32::from_rgb(0x40, 0xa0, 0x2b), // green
                egui::Color32::from_rgb(0xd2, 0x0f, 0x39), // red
                egui::Color32::from_rgb(0x9c, 0xa0, 0xb0), // subtext1
                egui::Color32::from_rgb(0x1e, 0x66, 0xf5), // blue
            ),
            Theme::OneLight => (
                egui::Color32::from_rgb(0x50, 0xa1, 0x4f), // green
                egui::Color32::from_rgb(0xe4, 0x56, 0x49), // red
                egui::Color32::from_rgb(0xa0, 0xa1, 0xa7), // comment
                egui::Color32::from_rgb(0x40, 0x78, 0xf2), // blue
            ),
        }
    }

    fn surface_colors(self) -> (egui::Color32, egui::Color32) {
        match self {
            Theme::Gruvbox => (
                egui::Color32::from_rgb(0x3c, 0x38, 0x36),
                egui::Color32::from_rgb(0x66, 0x5c, 0x54),
            ),
            Theme::SolarizedDark => (
                egui::Color32::from_rgb(0x07, 0x36, 0x42),
                egui::Color32::from_rgb(0x58, 0x6e, 0x75),
            ),
            Theme::Nord => (
                egui::Color32::from_rgb(0x3b, 0x42, 0x52),
                egui::Color32::from_rgb(0x4c, 0x56, 0x6a),
            ),
            Theme::Dracula => (
                egui::Color32::from_rgb(0x44, 0x47, 0x5a),
                egui::Color32::from_rgb(0x62, 0x72, 0xa4),
            ),
            Theme::Everforest => (
                egui::Color32::from_rgb(0x2d, 0x35, 0x32),
                egui::Color32::from_rgb(0x52, 0x5c, 0x57),
            ),
            Theme::Catppuccin => (
                egui::Color32::from_rgb(0x31, 0x32, 0x44),
                egui::Color32::from_rgb(0x58, 0x5b, 0x70),
            ),
            Theme::TokyoNight => (
                egui::Color32::from_rgb(0x24, 0x29, 0x3a),
                egui::Color32::from_rgb(0x41, 0x49, 0x68),
            ),
            Theme::RosyPaper => (
                egui::Color32::from_rgb(0xf3, 0xeb, 0xe5),
                egui::Color32::from_rgb(0xd4, 0xc0, 0xb4),
            ),
            Theme::SolarizedLight => (
                egui::Color32::from_rgb(0xee, 0xe8, 0xd5), // base2
                egui::Color32::from_rgb(0xcb, 0xc7, 0xbc), // base2 darker
            ),
            Theme::GithubLight => (
                egui::Color32::from_rgb(0xf6, 0xf8, 0xfa), // canvas-subtle
                egui::Color32::from_rgb(0xd0, 0xd7, 0xde), // border
            ),
            Theme::Latte => (
                egui::Color32::from_rgb(0xe6, 0xe9, 0xef), // surface0
                egui::Color32::from_rgb(0xcc, 0xd0, 0xda), // surface1
            ),
            Theme::OneLight => (
                egui::Color32::from_rgb(0xf2, 0xf2, 0xf2), // bg1
                egui::Color32::from_rgb(0xe5, 0xe5, 0xe6), // bg2
            ),
        }
    }
}

fn apply_theme(ctx: &egui::Context, theme: Theme) {
    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = egui::vec2(12.0, 8.0);
    style.spacing.window_margin = egui::Margin::same(16);
    style.spacing.button_padding = egui::vec2(16.0, 8.0);
    use egui::{FontFamily, FontId, TextStyle};
    style.text_styles = [
        (
            TextStyle::Heading,
            FontId::new(26.0, FontFamily::Proportional),
        ),
        (TextStyle::Body, FontId::new(15.0, FontFamily::Proportional)),
        (
            TextStyle::Monospace,
            FontId::new(14.0, FontFamily::Monospace),
        ),
        (
            TextStyle::Button,
            FontId::new(13.0, FontFamily::Proportional),
        ),
        (
            TextStyle::Small,
            FontId::new(11.0, FontFamily::Proportional),
        ),
    ]
    .into();
    ctx.set_style(style);

    let is_light = matches!(
        theme,
        Theme::RosyPaper
            | Theme::SolarizedLight
            | Theme::GithubLight
            | Theme::Latte
            | Theme::OneLight
    );

    // egui's default light/dark visuals affect things like text colors
    // (especially for TextEdit), so light themes must start from light visuals.
    let mut v = if is_light {
        egui::Visuals::light()
    } else {
        egui::Visuals::dark()
    };

    // (bg, bg1, bg2, fg_dim, selection)
    let (bg, bg1, bg2, fg_dim, selection) = match theme {
        Theme::Gruvbox => (
            egui::Color32::from_rgb(0x28, 0x28, 0x28),
            egui::Color32::from_rgb(0x3c, 0x38, 0x36),
            egui::Color32::from_rgb(0x50, 0x49, 0x45),
            egui::Color32::from_rgb(0xa8, 0x99, 0x84),
            egui::Color32::from_rgb(0x45, 0x85, 0x88),
        ),
        Theme::SolarizedDark => (
            egui::Color32::from_rgb(0x00, 0x2b, 0x36),
            egui::Color32::from_rgb(0x07, 0x36, 0x42),
            egui::Color32::from_rgb(0x58, 0x6e, 0x75),
            egui::Color32::from_rgb(0x65, 0x7b, 0x83),
            egui::Color32::from_rgb(0x26, 0x8b, 0xd2),
        ),
        Theme::Nord => (
            egui::Color32::from_rgb(0x2e, 0x34, 0x40),
            egui::Color32::from_rgb(0x3b, 0x42, 0x52),
            egui::Color32::from_rgb(0x43, 0x4c, 0x5e),
            egui::Color32::from_rgb(0x4c, 0x56, 0x6a),
            egui::Color32::from_rgb(0x5e, 0x81, 0xac),
        ),
        Theme::Dracula => (
            egui::Color32::from_rgb(0x28, 0x2a, 0x36),
            egui::Color32::from_rgb(0x44, 0x47, 0x5a),
            egui::Color32::from_rgb(0x62, 0x72, 0xa4),
            egui::Color32::from_rgb(0x62, 0x72, 0xa4),
            egui::Color32::from_rgb(0xbd, 0x93, 0xf9),
        ),
        Theme::Everforest => (
            egui::Color32::from_rgb(0x27, 0x2e, 0x33),
            egui::Color32::from_rgb(0x2d, 0x35, 0x32),
            egui::Color32::from_rgb(0x37, 0x40, 0x43),
            egui::Color32::from_rgb(0x85, 0x92, 0x89),
            egui::Color32::from_rgb(0x7f, 0xbb, 0xa3),
        ),
        Theme::Catppuccin => (
            egui::Color32::from_rgb(0x1e, 0x1e, 0x2e),
            egui::Color32::from_rgb(0x31, 0x32, 0x44),
            egui::Color32::from_rgb(0x45, 0x47, 0x5a),
            egui::Color32::from_rgb(0x93, 0x9a, 0xb7),
            egui::Color32::from_rgb(0x89, 0xb4, 0xfa),
        ),
        Theme::TokyoNight => (
            egui::Color32::from_rgb(0x1a, 0x1b, 0x26),
            egui::Color32::from_rgb(0x24, 0x29, 0x3a),
            egui::Color32::from_rgb(0x41, 0x49, 0x68),
            egui::Color32::from_rgb(0x56, 0x5f, 0x89),
            egui::Color32::from_rgb(0x7a, 0xa2, 0xf7),
        ),
        Theme::RosyPaper => (
            egui::Color32::from_rgb(0xfc, 0xf7, 0xf2),
            egui::Color32::from_rgb(0xef, 0xe3, 0xda),
            egui::Color32::from_rgb(0xe1, 0xcf, 0xc3),
            egui::Color32::from_rgb(0x6b, 0x55, 0x4d),
            egui::Color32::from_rgb(0xb2, 0x78, 0x8f),
        ),
        Theme::SolarizedLight => (
            egui::Color32::from_rgb(0xfd, 0xf6, 0xe3), // base3
            egui::Color32::from_rgb(0xee, 0xe8, 0xd5), // base2
            egui::Color32::from_rgb(0xcb, 0xc7, 0xbc), // base2 darker
            egui::Color32::from_rgb(0x65, 0x7b, 0x83), // base00
            egui::Color32::from_rgb(0x26, 0x8b, 0xd2), // blue
        ),
        Theme::GithubLight => (
            egui::Color32::from_rgb(0xff, 0xff, 0xff), // canvas-default
            egui::Color32::from_rgb(0xf6, 0xf8, 0xfa), // canvas-subtle
            egui::Color32::from_rgb(0xd0, 0xd7, 0xde), // border
            egui::Color32::from_rgb(0x65, 0x6d, 0x76), // fg-muted
            egui::Color32::from_rgb(0x02, 0x69, 0xd6), // blue
        ),
        Theme::Latte => (
            egui::Color32::from_rgb(0xef, 0xf1, 0xf5), // base
            egui::Color32::from_rgb(0xe6, 0xe9, 0xef), // surface0
            egui::Color32::from_rgb(0xcc, 0xd0, 0xda), // surface1
            egui::Color32::from_rgb(0x9c, 0xa0, 0xb0), // subtext1
            egui::Color32::from_rgb(0x1e, 0x66, 0xf5), // blue
        ),
        Theme::OneLight => (
            egui::Color32::from_rgb(0xfa, 0xfa, 0xfb), // bg
            egui::Color32::from_rgb(0xf2, 0xf2, 0xf2), // bg1
            egui::Color32::from_rgb(0xe5, 0xe5, 0xe6), // bg2
            egui::Color32::from_rgb(0xa0, 0xa1, 0xa7), // comment
            egui::Color32::from_rgb(0x40, 0x78, 0xf2), // blue
        ),
    };

    let fg = match theme {
        Theme::Gruvbox => egui::Color32::from_rgb(0xeb, 0xdb, 0xb2),
        Theme::SolarizedDark => egui::Color32::from_rgb(0x83, 0x94, 0x96),
        Theme::Nord => egui::Color32::from_rgb(0xd8, 0xde, 0xe9),
        Theme::Dracula => egui::Color32::from_rgb(0xf8, 0xf8, 0xf2),
        Theme::Everforest => egui::Color32::from_rgb(0xd3, 0xc6, 0xaa),
        Theme::Catppuccin => egui::Color32::from_rgb(0xcd, 0xd6, 0xf4),
        Theme::TokyoNight => egui::Color32::from_rgb(0xc0, 0xca, 0xf5),
        Theme::RosyPaper => egui::Color32::from_rgb(0x4b, 0x3a, 0x34),
        Theme::SolarizedLight => egui::Color32::from_rgb(0x65, 0x7b, 0x83),
        Theme::GithubLight => egui::Color32::from_rgb(0x1f, 0x23, 0x28),
        Theme::Latte => egui::Color32::from_rgb(0x4c, 0x4f, 0x69),
        Theme::OneLight => egui::Color32::from_rgb(0x38, 0x3a, 0x42),
    };

    // Separator line color — visible but subtle (bg2 for most themes)
    let separator_color = bg2;

    v.window_fill = bg;
    v.panel_fill = bg;
    v.faint_bg_color = bg1;
    v.extreme_bg_color = bg;
    v.override_text_color = Some(fg);

    v.widgets.noninteractive.bg_fill = bg;
    v.widgets.inactive.bg_fill = bg1;
    v.widgets.hovered.bg_fill = bg2;
    v.widgets.active.bg_fill = fg_dim;

    v.widgets.inactive.corner_radius = egui::CornerRadius::same(4);
    v.widgets.hovered.corner_radius = egui::CornerRadius::same(4);
    v.widgets.active.corner_radius = egui::CornerRadius::same(4);

    v.selection.bg_fill = selection.linear_multiply(0.4);

    // Keep noninteractive bg_stroke so the panel separator line is visible.
    // Zero out widget-level strokes to keep the flat retro look everywhere else.
    v.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, separator_color);
    v.widgets.inactive.bg_stroke = egui::Stroke::NONE;
    v.widgets.hovered.bg_stroke = egui::Stroke::NONE;
    v.widgets.active.bg_stroke = egui::Stroke::NONE;
    v.window_stroke = egui::Stroke::NONE;

    ctx.set_visuals(v);
}

// ── App ───────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum PaneMode {
    Split,
    Source,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LaunchScreen {
    Start,
    Editor,
}

#[derive(Clone)]
struct DocumentTab {
    tab_id: u64,
    path: PathBuf,
    editor_state: EditorDocumentState,
    persisted_markdown: String,
    doc_history: Vec<serde_json::Value>,
    replay_origin_wall_ms: u64,
    replay_url: Option<String>,
    published_history_len: Option<usize>,
    theme: Theme,
    pane_mode: PaneMode,
    doc_is_writable: bool,
}

struct NativeEditorApp {
    state: Arc<AppState>,
    editor: MarkdownEditor,
    pane_mode: PaneMode,
    status: String,
    status_is_error: bool,
    theme: Theme,
    doc_is_writable: bool,
    launch_screen: LaunchScreen,
    tabs: Vec<DocumentTab>,
    active_tab: Option<usize>,
    recent_files: Vec<PathBuf>,
    /// Set when the theme changes outside of the top-bar ComboBox (e.g. on file open).
    needs_theme_apply: bool,
    input_monitoring_prompt_dismissed: bool,
    focus_editor_next_frame: bool,
    launcher_return_tab_index: Option<usize>,
    startup_window_hidden_until_permission_resolves: bool,
    background_tx: Sender<BackgroundResult>,
    background_rx: Receiver<BackgroundResult>,
    saving_paths: HashSet<PathBuf>,
    opening_paths: HashSet<PathBuf>,
    uploading_tabs: HashSet<u64>,
    modal_error: Option<String>,
}

#[derive(Clone)]
struct OpenedDocumentData {
    tab_id: u64,
    path: PathBuf,
    editor_state: EditorDocumentState,
    persisted_markdown: String,
    doc_history: Vec<serde_json::Value>,
    replay_origin_wall_ms: u64,
    theme: Theme,
    pane_mode: PaneMode,
    doc_is_writable: bool,
    status: String,
    status_is_error: bool,
}

enum BackgroundResult {
    Status {
        message: String,
        is_error: bool,
    },
    SaveInPlace {
        path: PathBuf,
        markdown: String,
        result: Result<(), String>,
    },
    SaveAs {
        origin_tab_id: Option<u64>,
        path: PathBuf,
        markdown: String,
        snapshot: EditorDocumentState,
        theme: Theme,
        pane_mode: PaneMode,
        doc_is_writable: bool,
        result: Result<(), String>,
    },
    OpenDocument {
        path: PathBuf,
        result: Result<OpenedDocumentData, String>,
    },
    ReplayUpload {
        tab_id: u64,
        published_history_len: usize,
        open_when_ready: bool,
        result: Result<String, String>,
    },
}

fn replay_upload_required(
    replay_url: Option<&str>,
    published_history_len: Option<usize>,
    current_history_len: usize,
) -> bool {
    replay_url.is_none() || published_history_len != Some(current_history_len)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplayOpenPlan {
    OpenCachedReplay,
    UploadAndOpenAfterReady,
}

fn replay_open_plan(
    replay_url: Option<&str>,
    published_history_len: Option<usize>,
    current_history_len: usize,
) -> ReplayOpenPlan {
    if replay_upload_required(replay_url, published_history_len, current_history_len) {
        ReplayOpenPlan::UploadAndOpenAfterReady
    } else {
        ReplayOpenPlan::OpenCachedReplay
    }
}

fn should_autosave_document(
    current_document_path: Option<&std::path::Path>,
    current_markdown: &str,
    persisted_markdown: &str,
    launch_screen: LaunchScreen,
) -> bool {
    launch_screen == LaunchScreen::Editor
        && current_document_path.is_some()
        && current_markdown != persisted_markdown
}

fn should_skip_tab_reload(
    active_tab: Option<usize>,
    requested_index: usize,
    launch_screen: LaunchScreen,
) -> bool {
    active_tab == Some(requested_index) && launch_screen != LaunchScreen::Start
}

fn launcher_return_index(
    launcher_return_tab_index: Option<usize>,
    active_tab: Option<usize>,
    tab_count: usize,
) -> Option<usize> {
    if tab_count == 0 {
        return None;
    }
    Some(
        launcher_return_tab_index
            .or(active_tab)
            .unwrap_or(tab_count - 1)
            .min(tab_count - 1),
    )
}

fn replay_origin_wall_ms_for(now_ms: u64, last_history_t_ms: Option<u64>) -> u64 {
    now_ms.saturating_sub(last_history_t_ms.unwrap_or(0))
}

fn apply_save_as_result(
    tabs: &mut Vec<DocumentTab>,
    active_tab: Option<usize>,
    origin_tab_id: Option<u64>,
    path: PathBuf,
    markdown: String,
    snapshot: EditorDocumentState,
    theme: Theme,
    pane_mode: PaneMode,
    doc_is_writable: bool,
) -> Option<usize> {
    let normalized_path = normalize_existing_path(&path);
    let origin_index = origin_tab_id.and_then(|tab_id| find_tab_index_by_id(tabs, tab_id));
    if let Some(origin_index) = origin_index {
        if let Some(tab) = tabs.get_mut(origin_index) {
            tab.path = normalized_path;
            tab.editor_state = snapshot;
            tab.persisted_markdown = markdown;
            tab.theme = theme;
            tab.pane_mode = pane_mode;
            tab.doc_is_writable = doc_is_writable;
            return Some(origin_index);
        }
    }

    if origin_tab_id.is_none() {
        if let Some(active_index) = active_tab {
            if let Some(tab) = tabs.get_mut(active_index) {
                tab.path = normalized_path;
                tab.editor_state = snapshot;
                tab.persisted_markdown = markdown;
                tab.theme = theme;
                tab.pane_mode = pane_mode;
                tab.doc_is_writable = doc_is_writable;
                return Some(active_index);
            }
        }
    }

    tabs.push(DocumentTab {
        tab_id: next_tab_id(),
        path: normalized_path,
        editor_state: snapshot,
        persisted_markdown: markdown.clone(),
        doc_history: default_doc_history(&markdown),
        replay_origin_wall_ms: now_wall_ms(),
        replay_url: None,
        published_history_len: None,
        theme,
        pane_mode,
        doc_is_writable,
    });
    Some(tabs.len() - 1)
}

fn find_tab_index_by_id(tabs: &[DocumentTab], tab_id: u64) -> Option<usize> {
    tabs.iter().position(|tab| tab.tab_id == tab_id)
}

fn apply_replay_upload_result(
    tabs: &mut [DocumentTab],
    tab_id: u64,
    replay_url: String,
    published_history_len: usize,
) -> Option<usize> {
    let tab_index = find_tab_index_by_id(tabs, tab_id)?;
    if let Some(tab) = tabs.get_mut(tab_index) {
        tab.replay_url = Some(replay_url);
        tab.published_history_len = Some(published_history_len);
    }
    Some(tab_index)
}

fn now_wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn next_tab_id() -> u64 {
    NEXT_TAB_ID.fetch_add(1, Ordering::Relaxed)
}

fn normalize_existing_path(path: &std::path::Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_openable_path(lhs: &std::path::Path, rhs: &std::path::Path) -> bool {
    normalize_existing_path(lhs) == normalize_existing_path(rhs)
}

fn path_is_open_in_tabs(path: &std::path::Path, tabs: &[DocumentTab]) -> bool {
    tabs.iter().any(|tab| same_openable_path(&tab.path, path))
}

fn should_show_recent_file(path: &std::path::Path, tabs: &[DocumentTab]) -> bool {
    path.exists() || path_is_open_in_tabs(path, tabs)
}

fn startup_recent_file_path(recent_files: &[PathBuf]) -> Option<PathBuf> {
    recent_files.iter().find(|path| path.exists()).cloned()
}

fn request_editor_focus(ctx: &egui::Context) {
    ctx.memory_mut(|mem| mem.request_focus(egui::Id::new(EDITOR_WIDGET_ID)));
}

fn schedule_editor_focus(focus_editor_next_frame: &mut bool) {
    *focus_editor_next_frame = true;
}

fn toggle_vim_and_request_editor_focus(vim_enabled: &mut bool, focus_editor_next_frame: &mut bool) {
    *vim_enabled = !*vim_enabled;
    *focus_editor_next_frame = true;
}

fn toggle_pane_mode_and_request_editor_focus(
    pane_mode: &mut PaneMode,
    focus_editor_next_frame: &mut bool,
) {
    *pane_mode = match pane_mode {
        PaneMode::Split => PaneMode::Source,
        PaneMode::Source => PaneMode::Split,
    };
    *focus_editor_next_frame = true;
}

fn set_theme_and_request_editor_focus(theme_changed: bool, focus_editor_next_frame: &mut bool) {
    if theme_changed {
        *focus_editor_next_frame = true;
    }
}

fn history_last_t_ms(history: &[serde_json::Value]) -> Option<u64> {
    history
        .iter()
        .filter_map(|entry| entry.get("t").and_then(|t| t.as_u64()))
        .max()
}

fn default_doc_history(markdown: &str) -> Vec<serde_json::Value> {
    if markdown.is_empty() {
        Vec::new()
    } else {
        vec![serde_json::json!({
            "t": 0_u64,
            "pos": 0_usize,
            "del": "",
            "ins": markdown,
        })]
    }
}

fn history_entry_text(entry: &serde_json::Value) -> Option<&str> {
    entry.get("text").and_then(|text| text.as_str())
}

fn apply_history_entry(current: &str, entry: &serde_json::Value) -> Option<String> {
    if let Some(text) = history_entry_text(entry) {
        return Some(text.to_string());
    }

    let pos = entry.get("pos")?.as_u64()? as usize;
    let ins = entry.get("ins")?.as_str()?;
    let deleted = match entry.get("del") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(value) => {
            let count = value.as_u64()? as usize;
            current.chars().skip(pos).take(count).collect()
        }
        None => return None,
    };

    Some(
        TextChange {
            pos,
            del: deleted,
            ins: ins.to_string(),
            cursor_before: 0,
            cursor_after: 0,
        }
        .apply_to(current),
    )
}

fn history_last_text(history: &[serde_json::Value]) -> String {
    history.iter().fold(String::new(), |current, entry| {
        apply_history_entry(&current, entry).unwrap_or(current)
    })
}

fn build_history_delta_entry(
    previous: &str,
    next: &str,
    elapsed_ms: u64,
) -> Option<serde_json::Value> {
    editor::build_text_change(previous, next).map(|change| {
        serde_json::json!({
            "t": elapsed_ms,
            "pos": change.pos,
            "del": change.del,
            "ins": change.ins,
        })
    })
}

fn load_opened_document_data(
    path: &std::path::Path,
    recent_files: &[PathBuf],
) -> Result<Option<OpenedDocumentData>, String> {
    match document::load_document(path) {
        Ok(Some(doc)) => {
            let markdown = doc.payload.markdown.clone();
            let doc_history = if doc.payload.doc_history.is_empty() {
                default_doc_history(&markdown)
            } else {
                doc.payload.doc_history.clone()
            };
            let normalized_path = normalize_existing_path(path);
            let theme = Theme::from_storage_key(doc.payload.theme.as_deref());
            let pane_mode = match doc.payload.mode {
                EditorMode::Split => PaneMode::Split,
                EditorMode::Source => PaneMode::Source,
            };
            Ok(Some(OpenedDocumentData {
                tab_id: next_tab_id(),
                path: normalized_path,
                editor_state: EditorDocumentState {
                    markdown: markdown.clone(),
                    cursor: doc.payload.cursor,
                    mode: doc.payload.mode,
                    vim_enabled: false,
                    theme: doc.payload.theme.clone(),
                    undo_changes: doc.payload.undo_changes.clone(),
                    undo_index: doc.payload.undo_index,
                    recent_files: recent_files.to_vec(),
                    legacy_undo_revisions: Vec::new(),
                },
                persisted_markdown: markdown.clone(),
                replay_origin_wall_ms: replay_origin_wall_ms_for(
                    now_wall_ms(),
                    history_last_t_ms(&doc_history),
                ),
                doc_history,
                theme,
                pane_mode,
                doc_is_writable: true,
                status: format!(
                    "Opened: {}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ),
                status_is_error: false,
            }))
        }
        Ok(None) => Ok(None),
        Err(err) => match document::load_document_unverified(path) {
            Ok(Some(doc)) => {
                let markdown = doc.payload.markdown.clone();
                let doc_history = if doc.payload.doc_history.is_empty() {
                    default_doc_history(&markdown)
                } else {
                    doc.payload.doc_history.clone()
                };
                let normalized_path = normalize_existing_path(path);
                let theme = Theme::from_storage_key(doc.payload.theme.as_deref());
                let pane_mode = match doc.payload.mode {
                    EditorMode::Split => PaneMode::Split,
                    EditorMode::Source => PaneMode::Source,
                };
                Ok(Some(OpenedDocumentData {
                    tab_id: next_tab_id(),
                    path: normalized_path,
                    editor_state: EditorDocumentState {
                        markdown: markdown.clone(),
                        cursor: doc.payload.cursor,
                        mode: doc.payload.mode,
                        vim_enabled: false,
                        theme: doc.payload.theme.clone(),
                        undo_changes: doc.payload.undo_changes.clone(),
                        undo_index: doc.payload.undo_index,
                        recent_files: recent_files.to_vec(),
                        legacy_undo_revisions: Vec::new(),
                    },
                    persisted_markdown: markdown.clone(),
                    replay_origin_wall_ms: replay_origin_wall_ms_for(
                        now_wall_ms(),
                        history_last_t_ms(&doc_history),
                    ),
                    doc_history,
                    theme,
                    pane_mode,
                    doc_is_writable: false,
                    status: format!(
                        "Opened read-only: {}",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    ),
                    status_is_error: true,
                }))
            }
            Ok(None) => Ok(None),
            Err(unverified_err) => Err(if err == unverified_err {
                err
            } else {
                format!("{err} ({unverified_err})")
            }),
        },
    }
}

impl NativeEditorApp {
    fn set_info_status(&mut self, message: impl Into<String>) {
        self.status = message.into();
        self.status_is_error = false;
    }

    fn set_error_status(&mut self, message: impl Into<String>) {
        self.status.clear();
        self.status_is_error = false;
        self.modal_error = Some(message.into());
    }

    fn open_launcher(&mut self) {
        self.sync_active_tab_from_editor();
        self.launcher_return_tab_index = self.active_tab;
        self.active_tab = None;
        self.launch_screen = LaunchScreen::Start;
        self.set_info_status("Ready");
    }

    fn close_launcher(&mut self) {
        let Some(index) = launcher_return_index(
            self.launcher_return_tab_index,
            self.active_tab,
            self.tabs.len(),
        ) else {
            return;
        };
        self.launcher_return_tab_index = None;
        self.load_tab_into_editor(index);
    }

    fn close_current_tab(&mut self) {
        if self.launch_screen == LaunchScreen::Start {
            self.close_launcher();
        } else if let Some(index) = self.active_tab {
            self.close_tab(index);
        }
    }

    fn activate_next_tab(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        if self.launch_screen == LaunchScreen::Start {
            self.load_tab_into_editor(0);
            return;
        }
        let current = self.active_tab.unwrap_or(0);
        self.activate_tab((current + 1) % self.tabs.len());
    }

    fn activate_previous_tab(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        if self.launch_screen == LaunchScreen::Start {
            self.load_tab_into_editor(self.tabs.len() - 1);
            return;
        }
        let current = self.active_tab.unwrap_or(0);
        let previous = if current == 0 {
            self.tabs.len() - 1
        } else {
            current - 1
        };
        self.activate_tab(previous);
    }

    fn active_tab(&self) -> Option<&DocumentTab> {
        self.active_tab.and_then(|index| self.tabs.get(index))
    }

    fn active_tab_mut(&mut self) -> Option<&mut DocumentTab> {
        self.active_tab.and_then(|index| self.tabs.get_mut(index))
    }

    fn find_tab_index_by_path(&self, path: &std::path::Path) -> Option<usize> {
        self.tabs
            .iter()
            .position(|tab| same_openable_path(&tab.path, path))
    }

    fn current_editor_state_snapshot(&self) -> EditorDocumentState {
        let (undo_changes, undo_index) = self.editor.get_undo_state();
        EditorDocumentState {
            markdown: self.editor.to_markdown(),
            cursor: 0,
            mode: match self.pane_mode {
                PaneMode::Split => EditorMode::Split,
                PaneMode::Source => EditorMode::Source,
            },
            vim_enabled: self.editor.vim_enabled,
            theme: Some(self.theme.storage_key().to_string()),
            undo_changes,
            undo_index,
            recent_files: self.recent_files.clone(),
            legacy_undo_revisions: Vec::new(),
        }
    }

    fn sync_active_tab_from_editor(&mut self) {
        let snapshot = self.current_editor_state_snapshot();
        let theme = self.theme;
        let pane_mode = self.pane_mode;
        let doc_is_writable = self.doc_is_writable;
        if let Some(tab) = self.active_tab_mut() {
            tab.editor_state = snapshot;
            tab.theme = theme;
            tab.pane_mode = pane_mode;
            tab.doc_is_writable = doc_is_writable;
        }
    }

    fn load_tab_into_editor(&mut self, index: usize) {
        let Some(tab) = self.tabs.get(index).cloned() else {
            return;
        };
        self.active_tab = Some(index);
        self.editor = MarkdownEditor::new(&tab.editor_state.markdown);
        self.editor.mode_colors = tab.theme.mode_colors();
        self.editor.vim_enabled = tab.editor_state.vim_enabled;
        self.editor.set_undo_state(
            tab.editor_state.undo_changes.clone(),
            tab.editor_state.undo_index,
        );
        self.theme = tab.theme;
        self.pane_mode = tab.pane_mode;
        self.doc_is_writable = tab.doc_is_writable;
        self.needs_theme_apply = true;
        self.launch_screen = LaunchScreen::Editor;
        schedule_editor_focus(&mut self.focus_editor_next_frame);
        self.persist_editor_state_snapshot();
    }

    fn apply_opened_document(&mut self, opened: OpenedDocumentData) {
        let tab = DocumentTab {
            tab_id: opened.tab_id,
            path: opened.path.clone(),
            editor_state: opened.editor_state,
            persisted_markdown: opened.persisted_markdown,
            doc_history: opened.doc_history,
            replay_origin_wall_ms: opened.replay_origin_wall_ms,
            replay_url: None,
            published_history_len: None,
            theme: opened.theme,
            pane_mode: opened.pane_mode,
            doc_is_writable: opened.doc_is_writable,
        };
        self.open_tab(tab);
        self.record_recent_file(&opened.path);
        self.status = opened.status;
        self.status_is_error = opened.status_is_error;
    }

    fn spawn_open_document(&mut self, path: PathBuf, ctx: &egui::Context) {
        if !self.opening_paths.insert(path.clone()) {
            return;
        }
        self.set_info_status(format!(
            "Opening: {}",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));

        let tx = self.background_tx.clone();
        let repaint = ctx.clone();
        let recent_files = self.recent_files.clone();
        std::thread::spawn(move || {
            let result = load_opened_document_data(&path, &recent_files)
                .and_then(|maybe| maybe.ok_or_else(|| "File not found".to_string()));
            let _ = tx.send(BackgroundResult::OpenDocument { path, result });
            repaint.request_repaint();
        });
    }

    fn spawn_save_in_place(
        &mut self,
        path: PathBuf,
        payload: DocumentPayload,
        markdown: String,
        ctx: &egui::Context,
    ) {
        if !self.saving_paths.insert(path.clone()) {
            return;
        }
        self.set_info_status("Saving...");

        let tx = self.background_tx.clone();
        let repaint = ctx.clone();
        std::thread::spawn(move || {
            let result = document::save_document(&path, payload);
            let _ = tx.send(BackgroundResult::SaveInPlace {
                path,
                markdown,
                result,
            });
            repaint.request_repaint();
        });
    }

    fn spawn_save_as(
        &mut self,
        origin_tab_id: Option<u64>,
        path: PathBuf,
        payload: DocumentPayload,
        markdown: String,
        snapshot: EditorDocumentState,
        ctx: &egui::Context,
    ) {
        if !self.saving_paths.insert(path.clone()) {
            return;
        }
        self.set_info_status(format!(
            "Saving: {}",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));

        let tx = self.background_tx.clone();
        let repaint = ctx.clone();
        let theme = self.theme;
        let pane_mode = self.pane_mode;
        let doc_is_writable = self.doc_is_writable;
        std::thread::spawn(move || {
            let result = document::save_document(&path, payload);
            let _ = tx.send(BackgroundResult::SaveAs {
                origin_tab_id,
                path,
                markdown,
                snapshot,
                theme,
                pane_mode,
                doc_is_writable,
                result,
            });
            repaint.request_repaint();
        });
    }

    fn spawn_replay_upload(
        &mut self,
        tab_id: u64,
        document_name: Option<String>,
        doc_text: String,
        doc_history: Vec<serde_json::Value>,
        open_when_ready: bool,
        ctx: &egui::Context,
    ) {
        if !self.uploading_tabs.insert(tab_id) {
            return;
        }
        self.set_info_status("Uploading replay...");

        let tx = self.background_tx.clone();
        let repaint = ctx.clone();
        let state = Arc::clone(&self.state);
        let published_history_len = doc_history.len();
        std::thread::spawn(move || {
            let tx_for_progress = tx.clone();
            let result = handtyped_lib::upload::upload_replay_session_native_with_progress(
                &state,
                document_name.as_deref(),
                &doc_text,
                &doc_history,
                |stage| {
                    let _ = tx_for_progress.send(BackgroundResult::Status {
                        message: stage.to_string(),
                        is_error: false,
                    });
                    repaint.request_repaint();
                },
            );
            let _ = tx.send(BackgroundResult::ReplayUpload {
                tab_id,
                published_history_len,
                open_when_ready,
                result,
            });
            repaint.request_repaint();
        });
    }

    fn drain_background_results(&mut self, ctx: &egui::Context) {
        while let Ok(result) = self.background_rx.try_recv() {
            match result {
                BackgroundResult::Status { message, is_error } => {
                    if is_error {
                        self.set_error_status(message);
                    } else {
                        self.set_info_status(message);
                    }
                }
                BackgroundResult::SaveInPlace {
                    path,
                    markdown,
                    result,
                } => {
                    self.saving_paths.remove(&path);
                    match result {
                        Ok(()) => {
                            if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.path == path) {
                                tab.persisted_markdown = markdown;
                            }
                            self.set_info_status("Saved");
                        }
                        Err(err) => {
                            self.set_error_status(format!("Save failed: {err}"));
                        }
                    }
                }
                BackgroundResult::SaveAs {
                    origin_tab_id,
                    path,
                    markdown,
                    snapshot,
                    theme,
                    pane_mode,
                    doc_is_writable,
                    result,
                } => {
                    self.saving_paths.remove(&path);
                    match result {
                        Ok(()) => {
                            self.active_tab = apply_save_as_result(
                                &mut self.tabs,
                                self.active_tab,
                                origin_tab_id,
                                path.clone(),
                                markdown,
                                snapshot,
                                theme,
                                pane_mode,
                                doc_is_writable,
                            );
                            self.record_recent_file(&path);
                            self.set_info_status(format!(
                                "Saved: {}",
                                path.file_name().unwrap_or_default().to_string_lossy()
                            ));
                            self.enter_editor();
                            self.persist_editor_state_snapshot();
                        }
                        Err(err) => {
                            self.set_error_status(format!("Save failed: {err}"));
                        }
                    }
                }
                BackgroundResult::OpenDocument { path, result } => {
                    self.opening_paths.remove(&path);
                    match result {
                        Ok(opened) => self.apply_opened_document(opened),
                        Err(err) => {
                            self.set_error_status(format!("Failed to open: {err}"));
                        }
                    }
                }
                BackgroundResult::ReplayUpload {
                    tab_id,
                    published_history_len,
                    open_when_ready,
                    result,
                } => {
                    self.uploading_tabs.remove(&tab_id);
                    match result {
                        Ok(url) => {
                            let _ = apply_replay_upload_result(
                                &mut self.tabs,
                                tab_id,
                                url.clone(),
                                published_history_len,
                            );
                            self.set_info_status("Replay ready");
                            if open_when_ready {
                                ctx.open_url(egui::OpenUrl::new_tab(url));
                            }
                        }
                        Err(err) => {
                            if let Some(tab_index) = find_tab_index_by_id(&self.tabs, tab_id) {
                                if self.active_tab == Some(tab_index) {
                                    self.clear_replay_cache();
                                } else if let Some(tab) = self.tabs.get_mut(tab_index) {
                                    tab.replay_url = None;
                                    tab.published_history_len = None;
                                }
                            }
                            self.set_error_status(format!("Upload failed: {err}"));
                        }
                    }
                }
            }
        }
    }

    fn activate_tab(&mut self, index: usize) {
        self.launcher_return_tab_index = Some(index);
        if should_skip_tab_reload(self.active_tab, index, self.launch_screen) {
            return;
        }
        self.sync_active_tab_from_editor();
        self.load_tab_into_editor(index);
    }

    fn close_tab(&mut self, index: usize) {
        if index >= self.tabs.len() {
            return;
        }
        if self.active_tab == Some(index) {
            self.sync_active_tab_from_editor();
        }
        self.tabs.remove(index);
        if let Some(return_index) = self.launcher_return_tab_index {
            self.launcher_return_tab_index = if return_index == index {
                None
            } else if return_index > index {
                Some(return_index - 1)
            } else {
                Some(return_index)
            };
        }
        match self.tabs.len() {
            0 => {
                self.open_launcher();
            }
            _ => {
                let next_index = match self.active_tab {
                    Some(active) if active > index => active - 1,
                    Some(active) if active == index => index.min(self.tabs.len() - 1),
                    Some(active) => active,
                    None => 0,
                };
                self.load_tab_into_editor(next_index);
            }
        }
    }

    fn clear_replay_cache(&mut self) {
        if let Some(tab) = self.active_tab_mut() {
            tab.replay_url = None;
            tab.published_history_len = None;
        }
    }

    fn persist_editor_state_snapshot(&mut self) {
        let snapshot = self.current_editor_state_snapshot();

        if let Ok(mut current) = self.state.editor_state.lock() {
            *current = snapshot.clone();
        }

        let _ = editor::save_editor_state_to_disk(&snapshot);
    }

    fn enter_editor(&mut self) {
        self.launch_screen = LaunchScreen::Editor;
        schedule_editor_focus(&mut self.focus_editor_next_frame);
        self.persist_editor_state_snapshot();
    }

    fn persist_before_exit(&mut self) {
        self.sync_active_tab_from_editor();
        self.persist_editor_state_snapshot();
    }

    fn record_recent_file(&mut self, path: &std::path::Path) {
        const MAX_RECENT_FILES: usize = 8;
        let normalized_path = normalize_existing_path(path);

        self.recent_files
            .retain(|existing| normalize_existing_path(existing) != normalized_path);
        self.recent_files.insert(0, normalized_path);
        self.recent_files
            .retain(|existing| should_show_recent_file(existing, &self.tabs));
        if self.recent_files.len() > MAX_RECENT_FILES {
            self.recent_files.truncate(MAX_RECENT_FILES);
        }
        self.persist_editor_state_snapshot();
    }

    fn build_document_payload_for(
        &self,
        editor_state: &EditorDocumentState,
        theme: Theme,
        pane_mode: PaneMode,
        existing_path: Option<&std::path::Path>,
        doc_history: Vec<serde_json::Value>,
    ) -> DocumentPayload {
        let mut payload = DocumentPayload {
            markdown: editor_state.markdown.clone(),
            cursor: 0,
            mode: match pane_mode {
                PaneMode::Split => EditorMode::Split,
                PaneMode::Source => EditorMode::Source,
            },
            theme: Some(theme.storage_key().to_string()),
            undo_changes: editor_state.undo_changes.clone(),
            undo_index: editor_state.undo_index,
            session_keystrokes: Vec::new(),
            doc_history,
            session_nonce: uuid::Uuid::new_v4().to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            modified_at: chrono::Utc::now().to_rfc3339(),
            legacy_undo_revisions: Vec::new(),
        };

        if let Some(existing) =
            existing_path.and_then(|path| document::load_document(path).ok().flatten())
        {
            payload.created_at = existing.payload.created_at;
            payload.session_nonce = existing.payload.session_nonce;
            payload.session_keystrokes = existing.payload.session_keystrokes;
        }

        payload
    }

    fn build_document_payload(&self) -> DocumentPayload {
        let editor_state = self.current_editor_state_snapshot();
        let existing_path = self.active_tab().map(|tab| tab.path.as_path());
        let doc_history = self
            .active_tab()
            .map(|tab| tab.doc_history.clone())
            .unwrap_or_else(|| default_doc_history(&editor_state.markdown));
        self.build_document_payload_for(
            &editor_state,
            self.theme,
            self.pane_mode,
            existing_path,
            doc_history,
        )
    }

    fn new(cc: &eframe::CreationContext<'_>, state: Arc<AppState>) -> Self {
        egui_extras::install_image_loaders(&cc.egui_ctx);

        // Register fonts for bold markdown text and the Handtyped wordmark.
        let mut fonts = egui::FontDefinitions::default();
        for path in &[
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf",
        ] {
            if let Ok(data) = std::fs::read(path) {
                fonts.font_data.insert(
                    "bold".to_owned(),
                    std::sync::Arc::new(egui::FontData::from_owned(data)),
                );
                fonts
                    .families
                    .entry(egui::FontFamily::Name("Bold".into()))
                    .or_default()
                    .push("bold".to_owned());
                break;
            }
        }
        for path in &[
            "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
            "/System/Library/Fonts/Supplemental/Georgia.ttf",
        ] {
            if let Ok(data) = std::fs::read(path) {
                let font_name = if path.ends_with("Bold.ttf") {
                    "brand_serif_bold"
                } else {
                    "brand_serif"
                };
                fonts.font_data.insert(
                    font_name.to_owned(),
                    std::sync::Arc::new(egui::FontData::from_owned(data)),
                );
                fonts
                    .families
                    .entry(egui::FontFamily::Name("Brand".into()))
                    .or_default()
                    .push(font_name.to_owned());
            }
        }
        cc.egui_ctx.set_fonts(fonts);

        let loaded = state.editor_state.lock().unwrap().clone();
        let theme = Theme::from_storage_key(loaded.theme.as_deref());
        let pane_mode = match loaded.mode {
            EditorMode::Split => PaneMode::Split,
            EditorMode::Source => PaneMode::Source,
        };
        let mut editor = MarkdownEditor::new("");
        editor.mode_colors = theme.mode_colors();
        editor.vim_enabled = loaded.vim_enabled;

        // Apply synchronously for the font/spacing side-effects, then set the
        // flag so update() re-applies on the first real frame — eframe can
        // overwrite visuals between new() and the first update() call.
        apply_theme(&cc.egui_ctx, theme);

        let (background_tx, background_rx) = mpsc::channel();

        let mut app = Self {
            state,
            editor,
            pane_mode,
            status: "Ready".into(),
            status_is_error: false,
            theme,
            doc_is_writable: true,
            launch_screen: LaunchScreen::Start,
            tabs: Vec::new(),
            active_tab: None,
            recent_files: loaded.recent_files,
            needs_theme_apply: true,
            input_monitoring_prompt_dismissed: false,
            focus_editor_next_frame: false,
            launcher_return_tab_index: None,
            startup_window_hidden_until_permission_resolves: true,
            background_tx,
            background_rx,
            saving_paths: HashSet::new(),
            opening_paths: HashSet::new(),
            uploading_tabs: HashSet::new(),
            modal_error: None,
        };

        app.restore_recent_document_if_available();
        app
    }

    fn restore_recent_document_if_available(&mut self) {
        let Some(path) = startup_recent_file_path(&self.recent_files) else {
            return;
        };

        match load_opened_document_data(&path, &self.recent_files) {
            Ok(Some(opened)) => self.apply_opened_document(opened),
            Ok(None) => {}
            Err(err) => self.set_error_status(format!("Failed to restore last document: {err}")),
        }
    }

    fn prompt_for_input_monitoring_if_needed(&mut self, ctx: &egui::Context) {
        if self.hid_active() {
            self.input_monitoring_prompt_dismissed = false;
            return;
        }

        if self.input_monitoring_prompt_dismissed {
            return;
        }

        let screen_rect = ctx.available_rect();
        ctx.layer_painter(egui::LayerId::new(
            egui::Order::Foreground,
            egui::Id::new("input_monitoring_dimmer"),
        ))
        .rect_filled(screen_rect, 0.0, egui::Color32::from_black_alpha(160));

        egui::Area::new(egui::Id::new("input_monitoring_prompt"))
            .order(egui::Order::Foreground)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .show(ctx, |ui| {
                egui::Frame::popup(ui.style()).show(ui, |ui| {
                    ui.set_max_width(420.0);
                    ui.vertical_centered(|ui| {
                        ui.heading("Input Monitoring Required");
                        ui.add_space(10.0);
                        ui.label(
                            "Handtyped needs Input Monitoring to verify that writing comes from the built-in keyboard.",
                        );
                        ui.add_space(8.0);
                        ui.label(
                            "macOS may show its own permission dialog. If it does not, open Settings and enable Handtyped under Privacy & Security > Input Monitoring.",
                        );
                        ui.add_space(6.0);
                        ui.label("After enabling it, quit and reopen Handtyped.");
                        ui.add_space(16.0);
                        ui.horizontal(|ui| {
                            if ui.button("Open Settings").clicked() {
                                open_input_monitoring_settings();
                            }
                            if ui.button("Not Now").clicked() {
                                self.input_monitoring_prompt_dismissed = true;
                            }
                        });
                    });
                });
            });

        ctx.request_repaint();
    }

    fn should_reveal_startup_window_for_access(access: hid::InputMonitoringAccess) -> bool {
        matches!(access, hid::InputMonitoringAccess::Granted)
    }

    fn should_block_startup_ui_until_permission_resolves(
        startup_window_hidden_until_permission_resolves: bool,
        access: hid::InputMonitoringAccess,
    ) -> bool {
        startup_window_hidden_until_permission_resolves
            && !Self::should_reveal_startup_window_for_access(access)
    }

    fn sync_startup_window_visibility(&mut self, ctx: &egui::Context) -> bool {
        if !self.startup_window_hidden_until_permission_resolves {
            return false;
        }

        let access = unsafe { hid::input_monitoring_access() };
        if Self::should_block_startup_ui_until_permission_resolves(
            self.startup_window_hidden_until_permission_resolves,
            access,
        ) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
            ctx.request_repaint();
            return true;
        }

        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
        self.startup_window_hidden_until_permission_resolves = false;
        false
    }

    fn document_display_name(&self) -> String {
        if self.launch_screen == LaunchScreen::Start {
            return if self.tabs.is_empty() {
                "Handtyped".to_string()
            } else {
                "New Tab".to_string()
            };
        }
        self.active_tab()
            .map(|tab| &tab.path)
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Untitled".to_string())
    }

    fn update_window_title(&self, ctx: &egui::Context) {
        let title = if self.launch_screen == LaunchScreen::Start {
            "Handtyped".to_string()
        } else {
            format!("{} — Handtyped", self.document_display_name())
        };
        ctx.send_viewport_cmd(egui::ViewportCommand::Title(title));
    }

    fn persist(&mut self, ctx: &egui::Context) {
        self.status_is_error = false;
        if !self.doc_is_writable {
            return;
        }
        let md = self.editor.to_markdown();

        if let Some(path) = self.active_tab().map(|tab| tab.path.clone()) {
            let payload = self.build_document_payload();
            self.spawn_save_in_place(path, payload, md, ctx);
        } else {
            self.show_save_as_dialog(ctx);
        }
    }

    fn blank_editor_state(&self) -> EditorDocumentState {
        EditorDocumentState {
            markdown: String::new(),
            cursor: 0,
            mode: match self.pane_mode {
                PaneMode::Split => EditorMode::Split,
                PaneMode::Source => EditorMode::Source,
            },
            vim_enabled: self.editor.vim_enabled,
            theme: Some(self.theme.storage_key().to_string()),
            undo_changes: Vec::new(),
            undo_index: 0,
            recent_files: self.recent_files.clone(),
            legacy_undo_revisions: Vec::new(),
        }
    }

    fn open_tab(&mut self, tab: DocumentTab) {
        self.sync_active_tab_from_editor();
        self.tabs.push(tab);
        let index = self.tabs.len() - 1;
        self.load_tab_into_editor(index);
    }

    fn pick_document_save_path(&self, default_file_name: &str) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .add_filter("Handtyped Document", &[document::DOCUMENT_EXTENSION])
            .set_file_name(default_file_name)
            .save_file()
    }

    /// Create a new blank document, but only after the user names it.
    fn new_document(&mut self) {
        if let Some(path) = self.pick_document_save_path("document.ht") {
            let editor_state = self.blank_editor_state();
            let tab = DocumentTab {
                tab_id: next_tab_id(),
                path: path.clone(),
                editor_state,
                persisted_markdown: String::new(),
                doc_history: default_doc_history(""),
                replay_origin_wall_ms: now_wall_ms(),
                replay_url: None,
                published_history_len: None,
                theme: self.theme,
                pane_mode: self.pane_mode,
                doc_is_writable: true,
            };
            self.open_tab(tab);
            self.record_recent_file(&path);
            self.status = format!(
                "New document: {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            self.status_is_error = false;
        }
    }

    /// Open a Handtyped document from disk.
    fn open_document(&mut self, path: PathBuf, ctx: &egui::Context) {
        if let Some(existing_index) = self.find_tab_index_by_path(&path) {
            self.activate_tab(existing_index);
            self.set_info_status(format!(
                "Opened: {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            return;
        }
        self.spawn_open_document(path, ctx);
    }

    /// Save current document to a specific path.
    fn save_document_as(&mut self, path: PathBuf, ctx: &egui::Context) {
        let md = self.editor.to_markdown();
        let payload = self.build_document_payload();
        let snapshot = self.current_editor_state_snapshot();
        let origin_tab_id = self.active_tab().map(|tab| tab.tab_id);
        self.spawn_save_as(origin_tab_id, path, payload, md, snapshot, ctx);
    }

    /// Show file open dialog.
    fn show_open_dialog(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("Handtyped Document", document::DOCUMENT_OPEN_EXTENSIONS)
            .pick_file()
        {
            self.open_document(path, ctx);
        }
    }

    /// Show file save-as dialog.
    fn show_save_as_dialog(&mut self, ctx: &egui::Context) {
        if let Some(path) = self.pick_document_save_path("document.ht") {
            self.save_document_as(path, ctx);
        }
    }

    fn start_screen(&mut self, ctx: &egui::Context) {
        let panel_fill = ctx.style().visuals.panel_fill;
        let (surface, surface_border) = self.theme.surface_colors();
        let (_, error_color, dim_color, publish_color) = self.theme.ui_colors();
        egui::CentralPanel::default()
            .frame(egui::Frame::NONE.fill(panel_fill).inner_margin(32.0))
            .show(ctx, |ui| {
                ui.vertical_centered(|ui| {
                    ui.add_space(56.0);
                    egui::Frame::new()
                        .fill(surface)
                        .stroke(egui::Stroke::new(1.0, surface_border))
                        .corner_radius(egui::CornerRadius::same(12))
                        .inner_margin(egui::Margin::symmetric(28, 24))
                        .show(ui, |ui| {
                            ui.set_max_width(360.0);
                            ui.vertical_centered(|ui| {
                                ui.heading(
                                    egui::RichText::new("Handtyped")
                                        .family(egui::FontFamily::Name("Brand".into())),
                                );
                                ui.add_space(8.0);
                                ui.label(
                                    egui::RichText::new("Choose how you want to begin.")
                                        .color(dim_color),
                                );
                                if !self.hid_active() {
                                    ui.add_space(10.0);
                                    ui.label(
                                        egui::RichText::new("Input Monitoring is currently off.")
                                            .color(error_color),
                                    );
                                    ui.add_space(8.0);
                                    if ui
                                        .add_sized(
                                            [260.0, 34.0],
                                            egui::Button::new(
                                                egui::RichText::new(
                                                    "Open Input Monitoring Settings",
                                                )
                                                .color(ui.visuals().text_color()),
                                            )
                                            .fill(surface_border),
                                        )
                                        .clicked()
                                    {
                                        open_input_monitoring_settings();
                                    }
                                }
                                ui.add_space(20.0);

                                if ui
                                    .add_sized(
                                        [260.0, 40.0],
                                        egui::Button::new(
                                            egui::RichText::new("New Document")
                                                .color(egui::Color32::WHITE),
                                        )
                                        .fill(publish_color),
                                    )
                                    .clicked()
                                {
                                    self.new_document();
                                }
                                ui.add_space(8.0);

                                if ui
                                    .add_sized(
                                        [260.0, 40.0],
                                        egui::Button::new(
                                            egui::RichText::new("Open Document")
                                                .color(ui.visuals().text_color()),
                                        )
                                        .fill(surface_border),
                                    )
                                    .clicked()
                                {
                                    self.show_open_dialog(ctx);
                                }

                                ui.add_space(12.0);
                                ui.allocate_ui(egui::vec2(260.0, 18.0), |ui| {
                                    if !self.status.is_empty() && self.status != "Ready" {
                                        let status_color = if self.status_is_error {
                                            error_color
                                        } else {
                                            dim_color
                                        };
                                        ui.label(
                                            egui::RichText::new(&self.status)
                                                .color(status_color)
                                                .small(),
                                        );
                                    }
                                });

                                let recent_files: Vec<PathBuf> = self
                                    .recent_files
                                    .iter()
                                    .filter(|path| should_show_recent_file(path, &self.tabs))
                                    .cloned()
                                    .collect();

                                if !recent_files.is_empty() {
                                    ui.add_space(20.0);
                                    ui.separator();
                                    ui.add_space(12.0);
                                    ui.label(
                                        egui::RichText::new("Recent Files")
                                            .strong()
                                            .color(dim_color),
                                    );
                                    ui.add_space(8.0);

                                    for path in recent_files {
                                        let file_name = path
                                            .file_name()
                                            .map(|name| name.to_string_lossy().into_owned())
                                            .filter(|name| !name.is_empty())
                                            .unwrap_or_else(|| path.display().to_string());
                                        let response = ui.add_sized(
                                            [260.0, 36.0],
                                            egui::Button::new(
                                                egui::RichText::new(file_name)
                                                    .color(ui.visuals().text_color()),
                                            )
                                            .fill(surface_border),
                                        );
                                        let hover_path = path.display().to_string();
                                        if response.clicked() {
                                            self.open_document(path.clone(), ctx);
                                        }
                                        response.on_hover_text(hover_path);
                                        ui.add_space(6.0);
                                    }
                                }
                            });
                        });
                });
            });
    }

    fn hid_active(&self) -> bool {
        self.state.hid_active.load(Ordering::Acquire)
    }

    fn health_snapshot(&self) -> observability::HealthSnapshot {
        let observability = self.state.observability.lock().unwrap().clone();
        observability.health_snapshot(&self.state.integrity, self.hid_active())
    }

    fn error_modal(&mut self, ctx: &egui::Context) {
        let Some(message) = self.modal_error.clone() else {
            return;
        };

        egui::Window::new("Error")
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .collapsible(false)
            .resizable(false)
            .movable(false)
            .show(ctx, |ui| {
                ui.set_max_width(460.0);
                ui.label(message);
                ui.add_space(12.0);
                if ui.button("OK").clicked() {
                    self.modal_error = None;
                }
            });
    }

    fn frame_input_allowed(&self) -> bool {
        if !self.hid_active() {
            return false;
        }
        let pending = self.state.pending_builtin_keydowns.load(Ordering::Acquire);
        pending > 0
    }

    fn record_history_snapshot(&mut self) {
        let text = self.editor.to_markdown();
        let now_ms = now_wall_ms();
        if let Some(tab) = self.active_tab_mut() {
            let elapsed_ms = now_ms.saturating_sub(tab.replay_origin_wall_ms);
            let previous_text = history_last_text(&tab.doc_history);
            if let Some(next) = build_history_delta_entry(&previous_text, &text, elapsed_ms) {
                tab.doc_history.push(next);
            }
        }
    }

    fn top_bar(&mut self, ctx: &egui::Context) {
        let (_success_color, error_color, dim_color, publish_color) = self.theme.ui_colors();
        let (surface, surface_border) = self.theme.surface_colors();
        let tab_height = 32.0;
        let tab_row_height = tab_height + 10.0;

        egui::TopBottomPanel::top("top_bar")
            .frame(
                egui::Frame::NONE
                    .fill(ctx.style().visuals.panel_fill)
                    .inner_margin(egui::Margin::symmetric(20, 10)),
            )
            .show(ctx, |ui| {
                egui::ScrollArea::horizontal()
                    .id_salt("tab_bar")
                    .max_height(tab_row_height)
                    .auto_shrink([false, true])
                    .show(ui, |ui| {
                        ui.set_min_height(tab_row_height);
                        ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                            let mut switch_to = None;
                            let mut close_tab = None;
                            let mut close_launcher = false;

                            for (index, tab) in self.tabs.iter().enumerate() {
                                let is_active = self.active_tab == Some(index);
                                let file_name = tab
                                    .path
                                    .file_name()
                                    .map(|name| name.to_string_lossy().into_owned())
                                    .unwrap_or_else(|| "Document".to_string());
                                let title = file_name;
                                let tab_fill = if is_active {
                                    publish_color.linear_multiply(0.22)
                                } else {
                                    surface
                                };
                                let tab_stroke = if is_active {
                                    publish_color.linear_multiply(0.55)
                                } else {
                                    surface_border
                                };
                                let title_color = ui.visuals().text_color();
                                let close_color = if is_active { title_color } else { dim_color };

                                egui::Frame::new()
                                    .fill(tab_fill)
                                    .stroke(egui::Stroke::new(1.0, tab_stroke))
                                    .corner_radius(egui::CornerRadius::same(6))
                                    .inner_margin(egui::Margin::symmetric(8, 4))
                                    .show(ui, |ui| {
                                        ui.set_min_height(tab_height);
                                        ui.with_layout(
                                            egui::Layout::left_to_right(egui::Align::Center),
                                            |ui| {
                                                let tab_button = egui::Button::new(
                                                    egui::RichText::new(title).color(title_color),
                                                )
                                                .min_size(egui::vec2(0.0, tab_height - 8.0))
                                                .fill(egui::Color32::TRANSPARENT)
                                                .stroke(egui::Stroke::NONE);
                                                if ui.add(tab_button).clicked() {
                                                    switch_to = Some(index);
                                                }
                                                let close_button = egui::Button::new(
                                                    egui::RichText::new("x").color(close_color),
                                                )
                                                .min_size(egui::vec2(18.0, tab_height - 8.0))
                                                .fill(egui::Color32::TRANSPARENT)
                                                .stroke(egui::Stroke::NONE);
                                                if ui.add(close_button).clicked() {
                                                    close_tab = Some(index);
                                                }
                                            },
                                        );
                                    });
                            }

                            if self.launch_screen == LaunchScreen::Start && !self.tabs.is_empty() {
                                egui::Frame::new()
                                    .fill(publish_color.linear_multiply(0.22))
                                    .stroke(egui::Stroke::new(
                                        1.0,
                                        publish_color.linear_multiply(0.55),
                                    ))
                                    .corner_radius(egui::CornerRadius::same(6))
                                    .inner_margin(egui::Margin::symmetric(8, 4))
                                    .show(ui, |ui| {
                                        ui.set_min_height(tab_height);
                                        ui.with_layout(
                                            egui::Layout::left_to_right(egui::Align::Center),
                                            |ui| {
                                                let launcher_button = egui::Button::new(
                                                    egui::RichText::new("New Tab")
                                                        .color(ui.visuals().text_color()),
                                                )
                                                .min_size(egui::vec2(0.0, tab_height - 8.0))
                                                .fill(egui::Color32::TRANSPARENT)
                                                .stroke(egui::Stroke::NONE);
                                                let _ = ui.add(launcher_button);

                                                let close_button = egui::Button::new(
                                                    egui::RichText::new("x")
                                                        .color(ui.visuals().text_color()),
                                                )
                                                .min_size(egui::vec2(18.0, tab_height - 8.0))
                                                .fill(egui::Color32::TRANSPARENT)
                                                .stroke(egui::Stroke::NONE);
                                                if ui.add(close_button).clicked() {
                                                    close_launcher = true;
                                                }
                                            },
                                        );
                                    });
                            }

                            let new_tab_button =
                                egui::Button::new(egui::RichText::new("+").color(publish_color))
                                    .fill(surface)
                                    .stroke(egui::Stroke::new(1.0, surface_border))
                                    .min_size(egui::vec2(32.0, tab_height));
                            if ui.add(new_tab_button).clicked() {
                                self.open_launcher();
                            }

                            if let Some(index) = switch_to {
                                self.activate_tab(index);
                            }
                            if let Some(index) = close_tab {
                                self.close_tab(index);
                            }
                            if close_launcher {
                                self.close_launcher();
                            }
                        });
                    });

                ui.add_space(8.0);
                ui.horizontal_wrapped(|ui| {
                    let document_name = self.document_display_name();
                    ui.vertical(|ui| {
                        ui.heading(egui::RichText::new(document_name).strong());
                        ui.label(
                            egui::RichText::new("Handtyped")
                                .color(dim_color)
                                .family(egui::FontFamily::Name("Brand".into()))
                                .size(12.0),
                        );
                    });
                    ui.add_space(16.0);

                    if self.hid_active() {
                    } else {
                        ui.colored_label(error_color, "Input Monitoring Required");
                        if ui.button("Open Settings").clicked() {
                            open_input_monitoring_settings();
                        }
                    }

                    let health = self.health_snapshot();
                    let health_color = if health.healthy {
                        dim_color
                    } else {
                        error_color
                    };
                    let mut health_tooltip = String::new();
                    if !health.issues.is_empty() {
                        health_tooltip.push_str("Issues:\n");
                        for issue in &health.issues {
                            health_tooltip.push_str("• ");
                            health_tooltip.push_str(issue);
                            health_tooltip.push('\n');
                        }
                    }
                    if !health.notes.is_empty() {
                        if !health_tooltip.is_empty() {
                            health_tooltip.push('\n');
                        }
                        health_tooltip.push_str("Notes:\n");
                        for note in &health.notes {
                            health_tooltip.push_str("• ");
                            health_tooltip.push_str(note);
                            health_tooltip.push('\n');
                        }
                    }
                    let health_label = if health.healthy {
                        format!("Health: {}", health.headline)
                    } else {
                        let short_issue = health
                            .issues
                            .first()
                            .cloned()
                            .unwrap_or_else(|| health.headline.clone());
                        format!("Health: {} ({short_issue})", health.headline)
                    };
                    let health_response = ui.label(
                        egui::RichText::new(health_label)
                            .color(health_color)
                            .small(),
                    );
                    if !health_tooltip.is_empty() {
                        health_response.on_hover_text(health_tooltip);
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        // Theme dropdown
                        let prev_theme = self.theme;
                        egui::ComboBox::from_id_salt("theme_picker")
                            .selected_text(self.theme.label())
                            .show_ui(ui, |ui| {
                                for &t in Theme::all() {
                                    ui.selectable_value(&mut self.theme, t, t.label());
                                }
                            });
                        if self.theme != prev_theme {
                            apply_theme(ctx, self.theme);
                            self.editor.mode_colors = self.theme.mode_colors();
                            let theme = self.theme;
                            if let Some(tab) = self.active_tab_mut() {
                                tab.theme = theme;
                            }
                            set_theme_and_request_editor_focus(
                                self.theme != prev_theme,
                                &mut self.focus_editor_next_frame,
                            );
                            self.set_info_status(format!("Theme: {}", self.theme.label()));
                        }

                        ui.add_space(8.0);

                        // Open replay (publishes first if needed)
                        let open_replay_clicked = ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new("Open replay").color(egui::Color32::WHITE),
                                )
                                .fill(publish_color),
                            )
                            .clicked();

                        if open_replay_clicked {
                            self.record_history_snapshot();
                            let doc_text = self.editor.to_markdown();
                            let replay_state = self.active_tab().map(|tab| {
                                (
                                    tab.path
                                        .file_name()
                                        .map(|name| name.to_string_lossy().to_string()),
                                    tab.replay_url.clone(),
                                    tab.published_history_len,
                                    tab.doc_history.clone(),
                                )
                            });
                            if let Some((
                                document_name,
                                replay_url,
                                published_history_len,
                                doc_history,
                            )) = replay_state
                            {
                                match replay_open_plan(
                                    replay_url.as_deref(),
                                    published_history_len,
                                    doc_history.len(),
                                ) {
                                    ReplayOpenPlan::UploadAndOpenAfterReady => {
                                        if let Some(tab_id) =
                                            self.active_tab().map(|tab| tab.tab_id)
                                        {
                                            self.spawn_replay_upload(
                                                tab_id,
                                                document_name,
                                                doc_text,
                                                doc_history,
                                                true,
                                                ctx,
                                            );
                                        }
                                    }
                                    ReplayOpenPlan::OpenCachedReplay => {
                                        if let Some(url) =
                                            self.active_tab().and_then(|tab| tab.replay_url.clone())
                                        {
                                            ctx.open_url(egui::OpenUrl::new_tab(url));
                                        }
                                    }
                                }
                            }
                        }

                        if ui
                            .button(match self.pane_mode {
                                PaneMode::Split => "Source Only",
                                PaneMode::Source => "Split Preview",
                            })
                            .clicked()
                        {
                            toggle_pane_mode_and_request_editor_focus(
                                &mut self.pane_mode,
                                &mut self.focus_editor_next_frame,
                            );
                            let pane_mode = self.pane_mode;
                            if let Some(tab) = self.active_tab_mut() {
                                tab.pane_mode = pane_mode;
                            }
                        }

                        let vim_label = if self.editor.vim_enabled {
                            "Vim Beta: ON"
                        } else {
                            "Vim Beta: OFF"
                        };
                        if ui.button(vim_label).clicked() {
                            toggle_vim_and_request_editor_focus(
                                &mut self.editor.vim_enabled,
                                &mut self.focus_editor_next_frame,
                            );
                        }
                    });
                });
            });
    }

    fn editor_pane(&mut self, ui: &mut egui::Ui) {
        if self.focus_editor_next_frame {
            request_editor_focus(ui.ctx());
            self.focus_editor_next_frame = false;
        }
        let hid_ok = self.frame_input_allowed() && self.doc_is_writable;
        match self.editor.show(ui, hid_ok) {
            handtyped_lib::wysiwyg::EditorResponse::Changed => {
                self.record_history_snapshot();
                self.clear_replay_cache();
                self.persist_editor_state_snapshot();
            }
            handtyped_lib::wysiwyg::EditorResponse::SaveRequested => {
                self.persist(ui.ctx());
            }
            handtyped_lib::wysiwyg::EditorResponse::PasteBlocked => {
                self.set_error_status("Paste blocked: copy from Handtyped first");
            }
            handtyped_lib::wysiwyg::EditorResponse::None => {}
        }
    }

    fn preview_pane(&self, ui: &mut egui::Ui) {
        // Use horizontal scrolling instead of minimum width constraint.
        egui::ScrollArea::both()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.set_min_width(200.0); // Allow shrinking below text width
                render_markdown_preview(ui, &self.editor.to_markdown());
            });
    }
}

impl eframe::App for NativeEditorApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_background_results(ctx);
        self.sync_active_tab_from_editor();
        self.update_window_title(ctx);
        let startup_window_blocking = self.sync_startup_window_visibility(ctx);
        if startup_window_blocking {
            return;
        }

        // Apply theme if changed outside of the top-bar dropdown (e.g. file open).
        if self.needs_theme_apply {
            apply_theme(ctx, self.theme);
            self.needs_theme_apply = false;
        }

        let previous_tab_pressed = ctx.input_mut(|input| {
            input.consume_key(
                egui::Modifiers {
                    ctrl: true,
                    shift: true,
                    ..Default::default()
                },
                egui::Key::Tab,
            )
        });
        if previous_tab_pressed {
            self.activate_previous_tab();
        }

        let next_tab_pressed = ctx.input_mut(|input| {
            input.consume_key(
                egui::Modifiers {
                    ctrl: true,
                    ..Default::default()
                },
                egui::Key::Tab,
            )
        });
        if next_tab_pressed {
            self.activate_next_tab();
        }

        // Poll for native macOS menu events.
        #[cfg(target_os = "macos")]
        {
            while let Ok(event) = muda::MenuEvent::receiver().try_recv() {
                match menu_event_action(event.id.0.as_str()) {
                    MenuAction::New => self.open_launcher(),
                    MenuAction::NewTab => self.open_launcher(),
                    MenuAction::Open => self.show_open_dialog(ctx),
                    MenuAction::CloseTab => self.close_current_tab(),
                    MenuAction::Save => self.persist(ctx),
                    MenuAction::SaveAs => self.show_save_as_dialog(ctx),
                    MenuAction::NextTab => self.activate_next_tab(),
                    MenuAction::PreviousTab => self.activate_previous_tab(),
                    MenuAction::Unknown => {}
                }
            }
        }

        let current_md = self.editor.to_markdown();
        if should_autosave_document(
            self.active_tab().map(|tab| tab.path.as_path()),
            &current_md,
            self.active_tab()
                .map(|tab| tab.persisted_markdown.as_str())
                .unwrap_or(""),
            self.launch_screen,
        ) {
            self.persist(ctx);
        }

        if self.launch_screen == LaunchScreen::Start {
            if !self.tabs.is_empty() {
                self.top_bar(ctx);
            }
            self.start_screen(ctx);
            self.error_modal(ctx);
            return;
        }

        if !self.hid_active() && !self.input_monitoring_prompt_dismissed {
            self.prompt_for_input_monitoring_if_needed(ctx);
            self.error_modal(ctx);
            return;
        }

        self.top_bar(ctx);
        self.prompt_for_input_monitoring_if_needed(ctx);
        self.error_modal(ctx);

        let panel_fill = ctx.style().visuals.panel_fill;

        if self.pane_mode == PaneMode::Split {
            egui::SidePanel::right("preview_panel")
                .resizable(true)
                .min_width(150.0)
                .default_width(ctx.screen_rect().width() * 0.4)
                .frame(egui::Frame::NONE.fill(panel_fill).inner_margin(24.0))
                .show(ctx, |ui| {
                    self.preview_pane(ui);
                });
        }

        egui::CentralPanel::default()
            .frame(egui::Frame::NONE.fill(panel_fill).inner_margin(24.0))
            .show(ctx, |ui| {
                self.editor_pane(ui);
            });
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.persist_before_exit();
    }
}

// ── Preview renderer ──────────────────────────────────────────────────────────

fn render_markdown_preview(ui: &mut egui::Ui, markdown: &str) {
    let blocks = parse_markdown_for_preview(markdown);
    egui::ScrollArea::vertical()
        .id_salt("preview_scroll")
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            for block in &blocks {
                match block {
                    PreviewBlock::Heading { level, segs, quote } => {
                        let size = match level {
                            1 => 28.0,
                            2 => 22.0,
                            3 => 18.0,
                            4 => 16.0,
                            _ => 14.0,
                        };
                        ui.add_space(4.0);
                        ui.horizontal_wrapped(|ui| {
                            if *quote {
                                ui.colored_label(egui::Color32::GRAY, "▌ ");
                            }
                            for seg in segs {
                                preview_seg_widget(
                                    ui,
                                    &PreviewBlockSegRef {
                                        text: &seg.text,
                                        link_url: seg.link_url.as_deref(),
                                        bold: true,
                                        italic: seg.italic,
                                        code: seg.code,
                                        strike: seg.strike,
                                    },
                                    size,
                                );
                            }
                        });
                        ui.add_space(2.0);
                    }
                    PreviewBlock::Para {
                        segs,
                        indent,
                        list_number,
                        quote,
                    } => {
                        ui.horizontal_wrapped(|ui| {
                            ui.spacing_mut().item_spacing.x = 0.0;
                            if *quote {
                                ui.colored_label(egui::Color32::GRAY, "▌ ");
                            }
                            if *indent > 0 {
                                ui.add_space(*indent as f32 * 12.0);
                                if let Some(n) = list_number {
                                    ui.label(format!("{}. ", n));
                                } else {
                                    ui.label("• ");
                                }
                            }
                            for seg in segs {
                                preview_seg_widget(
                                    ui,
                                    &PreviewBlockSegRef {
                                        text: &seg.text,
                                        link_url: seg.link_url.as_deref(),
                                        bold: seg.bold,
                                        italic: seg.italic,
                                        code: seg.code,
                                        strike: seg.strike,
                                    },
                                    15.0,
                                );
                            }
                        });
                    }
                    PreviewBlock::Code {
                        text,
                        quote,
                        indent,
                    } => {
                        let code_bg = ui.visuals().code_bg_color;
                        let text_color = ui.visuals().text_color();
                        ui.add_space(2.0);
                        ui.horizontal(|ui| {
                            if *quote {
                                ui.colored_label(egui::Color32::GRAY, "▌ ");
                            }
                            if *indent > 0 {
                                ui.add_space(*indent as f32 * 12.0);
                            }
                            egui::Frame::new()
                                .fill(code_bg)
                                .inner_margin(egui::Margin::same(8))
                                .show(ui, |ui| {
                                    ui.set_min_width(ui.available_width());
                                    ui.label(
                                        egui::RichText::new(text.as_str())
                                            .monospace()
                                            .color(text_color),
                                    );
                                });
                        });
                        ui.add_space(2.0);
                    }
                    PreviewBlock::Image { alt, url } => {
                        ui.add_space(6.0);
                        let uri = preview_image_uri(url);
                        let max_width = ui.available_width().max(120.0);
                        let image = egui::Image::from_uri(uri.clone())
                            .alt_text(alt)
                            .max_width(max_width)
                            .max_height(360.0)
                            .shrink_to_fit();
                        let response = ui.add(image);
                        if response.hovered() && !alt.is_empty() {
                            response.on_hover_text(alt);
                        }
                        ui.add_space(6.0);
                    }
                    PreviewBlock::Rule => {
                        ui.separator();
                    }
                }
            }
        });
}

fn preview_link_color() -> egui::Color32 {
    egui::Color32::from_rgb(0x26, 0x8b, 0xd2)
}

fn preview_link_target(url: &str) -> egui::OpenUrl {
    egui::OpenUrl::new_tab(url.to_string())
}

fn preview_segment_is_clickable(link_url: Option<&str>) -> bool {
    link_url.is_some()
}

fn preview_seg_widget(ui: &mut egui::Ui, seg: &PreviewBlockSegRef<'_>, size: f32) {
    if seg.text.is_empty() {
        return;
    }

    let mut rt = if seg.code {
        egui::RichText::new(seg.text)
            .monospace()
            .size((size - 2.0).max(13.0))
            .background_color(ui.visuals().code_bg_color)
    } else {
        egui::RichText::new(seg.text).size(size)
    };
    if seg.bold {
        rt = rt.family(egui::FontFamily::Name("Bold".into()));
    }
    if seg.italic {
        rt = rt.italics();
    }
    if seg.strike {
        rt = rt.strikethrough();
    }

    if preview_segment_is_clickable(seg.link_url) {
        let url = seg
            .link_url
            .expect("clickable preview segments must carry a link url");
        rt = rt.color(preview_link_color());
        let response = ui
            .add(egui::Hyperlink::from_label_and_url(rt, url))
            .on_hover_text(url);
        if response.clicked() {
            ui.ctx().open_url(preview_link_target(url));
        }
    } else {
        ui.label(rt);
    }
}

struct PreviewBlockSegRef<'a> {
    text: &'a str,
    link_url: Option<&'a str>,
    bold: bool,
    italic: bool,
    code: bool,
    strike: bool,
}

fn preview_image_uri(url: &str) -> String {
    if url.contains("://") {
        return url.to_string();
    }

    let path = PathBuf::from(url);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    format!("file://{}", absolute.to_string_lossy())
}
