use egui::{Event, Key, Modifiers};
use handtyped_lib::document;
use handtyped_lib::editor;
use handtyped_lib::wysiwyg::{EditorResponse, MarkdownEditor};
use tempfile::TempDir;

struct WorkflowHarness {
    ctx: egui::Context,
    editor: MarkdownEditor,
    history: Vec<serde_json::Value>,
    last_text: String,
    elapsed_ms: u64,
}

impl WorkflowHarness {
    fn new(initial: &str, vim_enabled: bool) -> Self {
        let ctx = egui::Context::default();
        let mut editor = MarkdownEditor::new(initial);
        editor.vim_enabled = vim_enabled;

        let mut harness = Self {
            ctx,
            editor,
            history: Vec::new(),
            last_text: initial.to_string(),
            elapsed_ms: 0,
        };
        harness.prime_focus();
        harness
    }

    fn prime_focus(&mut self) {
        let editor_id = egui::Id::new("handtyped_md_editor");
        self.ctx.memory_mut(|m| m.request_focus(editor_id));
        let _ = self.ctx.run(egui::RawInput::default(), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let _ = self.editor.show(ui, true);
            });
        });
    }

    fn advance(&mut self, ms: u64) {
        self.elapsed_ms = self.elapsed_ms.saturating_add(ms);
    }

    fn record_snapshot(&mut self) {
        let text = self.editor.to_markdown();
        if text != self.last_text {
            if let Some(change) = editor::build_text_change(&self.last_text, &text) {
                self.history.push(serde_json::json!({
                    "t": self.elapsed_ms,
                    "pos": change.pos,
                    "del": change.del,
                    "ins": change.ins,
                }));
            }
            self.last_text = text;
        }
    }

    fn frame(&mut self, events: Vec<Event>, hid_ok: bool) -> EditorResponse {
        let mut raw = egui::RawInput::default();
        raw.events = events;

        let editor_id = egui::Id::new("handtyped_md_editor");
        self.ctx.memory_mut(|m| m.request_focus(editor_id));

        let mut response = EditorResponse::None;
        let _ = self.ctx.run(raw, |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                response = self.editor.show(ui, hid_ok);
            });
        });

        self.record_snapshot();
        response
    }

    fn type_text(&mut self, text: &str) {
        for ch in text.chars() {
            self.advance(90);
            if ch == '\n' {
                self.frame(
                    vec![Event::Key {
                        key: Key::Enter,
                        pressed: true,
                        repeat: false,
                        modifiers: Modifiers::NONE,
                        physical_key: None,
                    }],
                    true,
                );
            } else {
                self.frame(vec![Event::Text(ch.to_string())], true);
            }
        }
    }

    fn press_key(&mut self, key: Key, modifiers: Modifiers) -> EditorResponse {
        self.advance(120);
        self.frame(
            vec![Event::Key {
                key,
                pressed: true,
                repeat: false,
                modifiers,
                physical_key: None,
            }],
            true,
        )
    }

    fn pause(&mut self, ms: u64) {
        self.advance(ms);
    }

    fn payload(&self) -> document::DocumentPayload {
        let mut payload = document::new_document_payload(self.editor.to_markdown());
        let (undo_changes, undo_index) = self.editor.get_undo_state();
        payload.undo_changes = undo_changes;
        payload.undo_index = undo_index;
        payload.doc_history = self.history.clone();
        payload
    }
}

fn replay_text_from_history(history: &[serde_json::Value]) -> String {
    history.iter().fold(String::new(), |current, entry| {
        let pos = entry
            .get("pos")
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as usize;
        let del = entry
            .get("del")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let ins = entry
            .get("ins")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut chars: Vec<char> = current.chars().collect();
        let pos = pos.min(chars.len());
        let delete_len = del.chars().count();
        let end = pos.saturating_add(delete_len).min(chars.len());
        chars.splice(pos..end, ins.chars());
        chars.into_iter().collect()
    })
}

#[test]
fn end_to_end_typing_undo_redo_reopen_vim_and_replay_history() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("workflow.ht");

    // Phase 1: non-Vim typing with undo/redo.
    let mut harness = WorkflowHarness::new("", false);
    harness.type_text("Hello");
    harness.pause(1_500);
    harness.type_text(" world");

    assert_eq!(harness.editor.to_markdown(), "Hello world");
    let initial_history_len = harness.history.len();
    assert!(initial_history_len >= 3);

    let undo_response = harness.press_key(Key::Z, Modifiers::MAC_CMD);
    assert_eq!(undo_response, EditorResponse::Changed);
    assert_eq!(harness.editor.to_markdown(), "");

    let redo_response = harness.press_key(Key::Z, Modifiers::MAC_CMD | Modifiers::SHIFT);
    assert_eq!(redo_response, EditorResponse::Changed);
    assert_eq!(harness.editor.to_markdown(), "Hello world");

    let payload_before_reopen = harness.payload();
    document::save_document(&path, payload_before_reopen.clone()).unwrap();

    let loaded = document::load_document(&path).unwrap().unwrap();
    assert_eq!(loaded.payload.markdown, "Hello world");
    assert_eq!(loaded.payload.undo_index, payload_before_reopen.undo_index);
    assert_eq!(
        loaded.payload.undo_changes,
        payload_before_reopen.undo_changes
    );
    assert_eq!(
        loaded.payload.doc_history,
        payload_before_reopen.doc_history
    );

    // Phase 2: simulate quitting and reopening, then continue in Vim mode.
    let mut reopened = WorkflowHarness::new(&loaded.payload.markdown, true);
    reopened.history = loaded.payload.doc_history.clone();
    reopened.last_text = loaded.payload.markdown.clone();
    reopened.elapsed_ms = loaded
        .payload
        .doc_history
        .last()
        .and_then(|entry| entry.get("t"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    reopened.editor.set_undo_state(
        loaded.payload.undo_changes.clone(),
        loaded.payload.undo_index,
    );

    // Open a new line via Vim, type a short phrase, then test undo/redo.
    let vim_open_line = reopened.frame(vec![Event::Text("o".into())], true);
    assert_eq!(vim_open_line, EditorResponse::Changed);
    reopened.type_text("reopened line");
    assert!(reopened.editor.to_markdown().contains("reopened line"));

    let vim_escape = reopened.frame(
        vec![Event::Key {
            key: Key::Escape,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
            physical_key: None,
        }],
        true,
    );
    assert_eq!(vim_escape, EditorResponse::None);

    let vim_undo = reopened.frame(vec![Event::Text("u".into())], true);
    assert_eq!(vim_undo, EditorResponse::Changed);
    assert!(!reopened.editor.to_markdown().contains("reopened line"));

    let vim_redo = reopened.frame(
        vec![Event::Key {
            key: Key::R,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        }],
        true,
    );
    assert_eq!(vim_redo, EditorResponse::Changed);
    assert!(reopened.editor.to_markdown().contains("reopened line"));

    let final_payload = reopened.payload();
    document::save_document(&path, final_payload.clone()).unwrap();
    let final_loaded = document::load_document(&path).unwrap().unwrap();

    assert_eq!(final_loaded.payload.markdown, reopened.editor.to_markdown());
    assert_eq!(final_loaded.payload.doc_history, final_payload.doc_history);
    assert!(final_loaded.payload.doc_history.len() > initial_history_len);
    assert!(final_loaded
        .payload
        .doc_history
        .iter()
        .all(|entry| entry.get("text").is_none()));
    assert_eq!(
        replay_text_from_history(&final_loaded.payload.doc_history),
        final_loaded.payload.markdown
    );
}

#[test]
fn end_to_end_blog_post_session_looks_like_real_drafting_work() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("blog-post.ht");

    let mut harness = WorkflowHarness::new("", false);

    // Draft a more realistic blog post: heading, intro paragraph, typo, correction,
    // and a second paragraph separated by a pause.
    harness.type_text("# What I learned building Handtyped");
    harness.type_text("\n\n");
    harness.type_text("I started this project to answer a simple question: ");
    harness.type_text("can a document prove it was really typed by a person?");
    harness.pause(1_600);
    harness.type_text("\n\n");
    harness.type_text("The answer turned out to depend on hardware-gated input,");
    harness.type_text(" persistent undo, and a replay timeline that feels honest.");
    harness.pause(1_400);
    harness.type_text("\n\n");
    harness.type_text("Along the way I found a small bug in the replay clock");
    harness.type_text(" that made early drafts look incomplete.");
    harness.pause(1_400);
    harness.type_text("\n\n");
    harness.type_text("That bug was annoyingg");
    harness.frame(
        vec![Event::Key {
            key: Key::Backspace,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
            physical_key: None,
        }],
        true,
    );
    harness
        .type_text(", but the fix was straightforward once the timeline was measured correctly.");

    assert!(harness
        .editor
        .to_markdown()
        .starts_with("# What I learned building Handtyped"));
    assert!(harness.editor.to_markdown().contains("annoying"));
    assert!(harness.editor.to_markdown().contains("persistent undo"));
    assert!(harness.editor.to_markdown().contains("replay timeline"));

    // Undo and redo the last paragraph to prove the draft feels like a real editing session.
    let undo_response = harness.press_key(Key::Z, Modifiers::MAC_CMD);
    assert_eq!(undo_response, EditorResponse::Changed);
    assert!(!harness
        .editor
        .to_markdown()
        .contains("straightforward once the timeline was measured correctly"));

    let redo_response = harness.press_key(Key::Z, Modifiers::MAC_CMD | Modifiers::SHIFT);
    assert_eq!(redo_response, EditorResponse::Changed);
    assert!(harness
        .editor
        .to_markdown()
        .contains("straightforward once the timeline was measured correctly"));

    let payload_before_reopen = harness.payload();
    document::save_document(&path, payload_before_reopen.clone()).unwrap();

    let loaded = document::load_document(&path).unwrap().unwrap();
    assert!(loaded
        .payload
        .markdown
        .contains("# What I learned building Handtyped"));
    assert!(loaded.payload.markdown.contains("annoying"));
    assert!(loaded.payload.markdown.contains("persistent undo"));
    assert!(loaded.payload.markdown.contains("replay timeline"));
    assert!(loaded.payload.doc_history.len() >= 20);

    let mut reopened = WorkflowHarness::new(&loaded.payload.markdown, true);
    reopened.history = loaded.payload.doc_history.clone();
    reopened.last_text = loaded.payload.markdown.clone();
    reopened.elapsed_ms = loaded
        .payload
        .doc_history
        .last()
        .and_then(|entry| entry.get("t"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    reopened.editor.set_undo_state(
        loaded.payload.undo_changes.clone(),
        loaded.payload.undo_index,
    );

    // Vim-style final edit after reopen: open a new line and add a closing note.
    let open_line = reopened.frame(vec![Event::Text("o".into())], true);
    assert_eq!(open_line, EditorResponse::Changed);
    reopened.type_text("Readers should be able to follow the proof from the first keystroke.");
    let escape = reopened.frame(
        vec![Event::Key {
            key: Key::Escape,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
            physical_key: None,
        }],
        true,
    );
    assert_eq!(escape, EditorResponse::None);

    let final_payload = reopened.payload();
    document::save_document(&path, final_payload.clone()).unwrap();
    let final_loaded = document::load_document(&path).unwrap().unwrap();

    assert!(final_loaded
        .payload
        .markdown
        .contains("Readers should be able to follow the proof"));
    assert!(final_loaded.payload.doc_history.len() > loaded.payload.doc_history.len());
    assert!(final_loaded
        .payload
        .doc_history
        .iter()
        .all(|entry| entry.get("text").is_none()));
    assert_eq!(
        replay_text_from_history(&final_loaded.payload.doc_history),
        final_loaded.payload.markdown
    );
}

#[test]
fn end_to_end_hid_rejected_input_does_not_change_document_or_history() {
    let mut harness = WorkflowHarness::new("", false);

    let response = harness.frame(vec![Event::Text("x".into())], false);

    assert_eq!(response, EditorResponse::None);
    assert_eq!(harness.editor.to_markdown(), "");
    assert!(harness.history.is_empty());
}

#[test]
fn end_to_end_hid_rejected_input_after_real_typing_keeps_document_and_history_stable() {
    let mut harness = WorkflowHarness::new("", false);
    harness.type_text("safe");
    let history_before = harness.history.clone();

    let response = harness.frame(vec![Event::Text("x".into())], false);

    assert_eq!(response, EditorResponse::None);
    assert_eq!(harness.editor.to_markdown(), "safe");
    assert_eq!(harness.history, history_before);
    assert_eq!(replay_text_from_history(&harness.history), "safe");
}

#[test]
fn end_to_end_paste_is_blocked_without_mutating_document_or_history() {
    let mut harness = WorkflowHarness::new("", false);

    let paste_response = harness.frame(vec![Event::Paste("pasted text".into())], true);

    assert_eq!(paste_response, EditorResponse::PasteBlocked);
    assert_eq!(harness.editor.to_markdown(), "");
    assert!(harness.history.is_empty());

    harness.type_text("typed");
    assert_eq!(harness.editor.to_markdown(), "typed");
    assert_eq!(replay_text_from_history(&harness.history), "typed");
}

#[test]
fn end_to_end_backspace_session_reconstructs_from_compact_history() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("backspace.ht");

    let mut harness = WorkflowHarness::new("", false);
    harness.type_text("cat");
    harness.press_key(Key::Backspace, Modifiers::NONE);
    harness.type_text("r");

    assert_eq!(harness.editor.to_markdown(), "car");
    assert!(harness
        .history
        .iter()
        .all(|entry| entry.get("text").is_none()));

    let payload = harness.payload();
    document::save_document(&path, payload.clone()).unwrap();
    let loaded = document::load_document(&path).unwrap().unwrap();

    assert_eq!(replay_text_from_history(&loaded.payload.doc_history), "car");
    assert_eq!(loaded.payload.markdown, "car");
}

#[test]
fn end_to_end_multiline_draft_preserves_paragraph_boundaries() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("multiline.ht");

    let mut harness = WorkflowHarness::new("", false);
    harness.type_text("testhjhkjhjkh");
    harness.type_text("\n");
    harness.type_text("tjkhej");
    harness.type_text("\n");
    harness.type_text("dsfkh");

    let expected = "testhjhkjhjkh\ntjkhej\ndsfkh";
    assert_eq!(harness.editor.to_markdown(), expected);
    assert_eq!(replay_text_from_history(&harness.history), expected);

    let payload = harness.payload();
    document::save_document(&path, payload.clone()).unwrap();
    let loaded = document::load_document(&path).unwrap().unwrap();

    assert_eq!(loaded.payload.markdown, expected);
    assert_eq!(
        replay_text_from_history(&loaded.payload.doc_history),
        expected
    );

    let reopened = WorkflowHarness::new(&loaded.payload.markdown, false);
    assert_eq!(reopened.editor.to_markdown(), expected);
}

#[test]
fn end_to_end_long_form_draft_survives_save_reopen_with_all_paragraphs_intact() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("long-form.ht");

    let mut harness = WorkflowHarness::new("", false);
    let mut expected = String::new();

    let paragraphs = [
        "# A longer essay about Human Editing",
        "Human editing has to survive the boring parts too, not just the headline demo.",
        "That means the editor must keep blank lines, paragraph breaks, and small pauses intact.",
        "It also means the replay needs to feel like the same draft the person saw on screen.",
        "A long draft should still preserve the exact shape of the text after save and reopen.",
        "Undo and redo should not collapse the document into a different structure.",
        "The final check is always whether the document still reads like a human wrote it.",
        "If a single blank line disappears, the whole proof starts to feel suspicious.",
    ];

    for (idx, paragraph) in paragraphs.iter().enumerate() {
        if idx > 0 {
            harness.type_text("\n\n");
            expected.push_str("\n\n");
            harness.pause(750);
        }

        harness.type_text(paragraph);
        expected.push_str(paragraph);
    }

    assert_eq!(harness.editor.to_markdown(), expected);
    assert!(harness.history.len() >= paragraphs.len());
    assert_eq!(replay_text_from_history(&harness.history), expected);

    let payload = harness.payload();
    document::save_document(&path, payload.clone()).unwrap();
    let loaded = document::load_document(&path).unwrap().unwrap();

    assert_eq!(loaded.payload.markdown, expected);
    assert_eq!(loaded.payload.doc_history, payload.doc_history);
    assert_eq!(
        replay_text_from_history(&loaded.payload.doc_history),
        expected
    );

    let reopened = WorkflowHarness::new(&loaded.payload.markdown, false);
    assert_eq!(reopened.editor.to_markdown(), expected);
}

#[test]
fn end_to_end_markdown_rich_draft_roundtrips_through_save_reopen_and_replay() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("markdown-rich.ht");

    let mut harness = WorkflowHarness::new("", false);
    let mut expected = String::new();

    let segments = [
        "# Field notes from a real draft",
        "\n\n",
        "> The replay should preserve quoted context, not flatten it.",
        "\n\n",
        "- first checkpoint",
        "\n",
        "- second checkpoint",
        "\n\n",
        "Use `cargo test` before shipping the build.",
        "\n\n",
        "[Read the docs](https://handtyped.app) before the last review.",
        "\n\n",
        "The typo is subtlee",
    ];

    for segment in segments {
        harness.type_text(segment);
        expected.push_str(segment);
    }

    harness.frame(
        vec![Event::Key {
            key: Key::Backspace,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
            physical_key: None,
        }],
        true,
    );
    expected.pop();
    harness.type_text(".");
    expected.push('.');

    assert_eq!(harness.editor.to_markdown(), expected);
    assert!(expected.contains("> The replay should preserve quoted context"));
    assert!(expected.contains("- first checkpoint"));
    assert!(expected.contains("`cargo test`"));
    assert!(expected.contains("[Read the docs](https://handtyped.app)"));

    let undo_response = harness.press_key(Key::Z, Modifiers::MAC_CMD);
    assert_eq!(undo_response, EditorResponse::Changed);
    assert!(harness.editor.to_markdown().ends_with("subtle"));

    let redo_response = harness.press_key(Key::Z, Modifiers::MAC_CMD | Modifiers::SHIFT);
    assert_eq!(redo_response, EditorResponse::Changed);
    assert_eq!(harness.editor.to_markdown(), expected);

    let payload = harness.payload();
    document::save_document(&path, payload.clone()).unwrap();
    let loaded = document::load_document(&path).unwrap().unwrap();

    assert_eq!(loaded.payload.markdown, expected);
    assert_eq!(loaded.payload.doc_history, payload.doc_history);
    assert!(loaded
        .payload
        .doc_history
        .iter()
        .all(|entry| entry.get("text").is_none()));
    assert_eq!(
        replay_text_from_history(&loaded.payload.doc_history),
        loaded.payload.markdown
    );

    let mut reopened = WorkflowHarness::new(&loaded.payload.markdown, true);
    reopened.history = loaded.payload.doc_history.clone();
    reopened.last_text = loaded.payload.markdown.clone();
    reopened.elapsed_ms = loaded
        .payload
        .doc_history
        .last()
        .and_then(|entry| entry.get("t"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    reopened.editor.set_undo_state(
        loaded.payload.undo_changes.clone(),
        loaded.payload.undo_index,
    );

    let open_line = reopened.frame(vec![Event::Text("o".into())], true);
    assert_eq!(open_line, EditorResponse::Changed);
    reopened.type_text("Final note: markdown structure survived the full workflow.");
    reopened.frame(
        vec![Event::Key {
            key: Key::Escape,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
            physical_key: None,
        }],
        true,
    );

    let final_payload = reopened.payload();
    document::save_document(&path, final_payload.clone()).unwrap();
    let final_loaded = document::load_document(&path).unwrap().unwrap();

    assert!(final_loaded
        .payload
        .markdown
        .contains("Final note: markdown structure survived the full workflow."));
    assert_eq!(
        replay_text_from_history(&final_loaded.payload.doc_history),
        final_loaded.payload.markdown
    );
}

#[test]
fn smoke_realistic_blog_post_flow_preserves_editing_history_and_reopen_state() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("smoke.ht");

    let mut harness = WorkflowHarness::new("", false);

    // Create a new doc, type a realistic blog post, and make one correction.
    harness.type_text("# Shipping a human-edited draft");
    harness.type_text("\n\n");
    harness.type_text("I wanted the full path to survive the same way a reader would see it.");
    harness.pause(1_200);
    harness.type_text("\n\n");
    harness.type_text("That meant preserving the paragraph breaks, timing, and one small typo.");
    harness.pause(600);
    harness.type_text("\n\n");
    harness.type_text("The typo is annoyingg");
    harness.frame(
        vec![Event::Key {
            key: Key::Backspace,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
            physical_key: None,
        }],
        true,
    );
    harness.type_text(" so the smoke test can prove correction, undo, redo, save, quit, reopen, and replay all stay aligned.");

    assert!(harness
        .editor
        .to_markdown()
        .contains("# Shipping a human-edited draft"));
    assert!(harness.editor.to_markdown().contains("annoying"));
    assert!(harness
        .editor
        .to_markdown()
        .contains("undo, redo, save, quit, reopen, and replay"));

    // Undo and redo the last edit the way a human would before saving.
    let undo = harness.press_key(Key::Z, Modifiers::MAC_CMD);
    assert_eq!(undo, EditorResponse::Changed);
    assert!(!harness
        .editor
        .to_markdown()
        .contains("undo, redo, save, quit, reopen, and replay"));

    let redo = harness.press_key(Key::Z, Modifiers::MAC_CMD | Modifiers::SHIFT);
    assert_eq!(redo, EditorResponse::Changed);
    assert!(harness
        .editor
        .to_markdown()
        .contains("undo, redo, save, quit, reopen, and replay"));

    // Save, quit, and reopen.
    let payload_before_reopen = harness.payload();
    document::save_document(&path, payload_before_reopen.clone()).unwrap();
    let loaded = document::load_document(&path).unwrap().unwrap();

    assert_eq!(loaded.payload.markdown, harness.editor.to_markdown());
    assert_eq!(
        loaded.payload.doc_history,
        payload_before_reopen.doc_history
    );
    assert_eq!(
        replay_text_from_history(&loaded.payload.doc_history),
        loaded.payload.markdown
    );

    let mut reopened = WorkflowHarness::new(&loaded.payload.markdown, false);
    reopened.history = loaded.payload.doc_history.clone();
    reopened.last_text = loaded.payload.markdown.clone();
    reopened.elapsed_ms = loaded
        .payload
        .doc_history
        .last()
        .and_then(|entry| entry.get("t"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    reopened.editor.set_undo_state(
        loaded.payload.undo_changes.clone(),
        loaded.payload.undo_index,
    );

    assert_eq!(reopened.editor.to_markdown(), loaded.payload.markdown);

    // Publish-shaped payload check: the replay reconstruction should match exactly.
    let final_payload = reopened.payload();
    document::save_document(&path, final_payload.clone()).unwrap();
    let final_loaded = document::load_document(&path).unwrap().unwrap();

    assert_eq!(final_loaded.payload.markdown, reopened.editor.to_markdown());
    assert_eq!(final_loaded.payload.doc_history, final_payload.doc_history);
    assert_eq!(
        replay_text_from_history(&final_loaded.payload.doc_history),
        final_loaded.payload.markdown
    );
}
