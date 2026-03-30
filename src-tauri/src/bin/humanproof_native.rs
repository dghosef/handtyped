use eframe::egui;
use humanproof_lib::editor::{self, EditorDocumentState, EditorMode};
use humanproof_lib::hid;
use humanproof_lib::integrity;
use humanproof_lib::session::{AppState, SessionState};
use humanproof_lib::wysiwyg::MarkdownEditor;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

fn main() -> eframe::Result<()> {
    integrity::deny_debugger_attach();
    let report = integrity::run_checks();
    let start_mach = unsafe { hid::mach_absolute_time() };
    let state = Arc::new(AppState {
        session: Mutex::new(SessionState::new(start_mach)),
        editor_state: Mutex::new(editor::load_editor_state_from_disk().ok().flatten().unwrap_or_default()),
        hid_active: std::sync::atomic::AtomicBool::new(false),
        pending_builtin_keydowns: std::sync::atomic::AtomicI32::new(0),
        integrity: report,
        keyboard_info: Mutex::new(None),
        last_keydown_ns: std::sync::atomic::AtomicU64::new(0),
    });

    unsafe { hid::request_input_monitoring_access() };
    hid::start_hid_capture(Arc::clone(&state));

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1200.0, 780.0])
            .with_title("HumanProof Native"),
        ..Default::default()
    };

    eframe::run_native(
        "HumanProof Native",
        options,
        Box::new(move |cc| Ok(Box::new(NativeEditorApp::new(cc, Arc::clone(&state))))),
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PaneMode {
    Split,
    Source,
}

impl PaneMode {
    fn label(self) -> &'static str {
        match self {
            Self::Split => "Split",
            Self::Source => "Source",
        }
    }
}

struct NativeEditorApp {
    state: Arc<AppState>,
    editor: MarkdownEditor,
    persisted_markdown: String,
    pane_mode: PaneMode,
    vim_enabled: bool,
    vim_mode: VimMode,
    status: String,
    proof_url: Option<String>,
    proof_status: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VimMode {
    Insert,
    Normal,
}

impl NativeEditorApp {
    fn new(_cc: &eframe::CreationContext<'_>, state: Arc<AppState>) -> Self {
        let loaded = state.editor_state.lock().unwrap().clone();
        let pane_mode = match loaded.mode {
            EditorMode::Split => PaneMode::Split,
            EditorMode::Source => PaneMode::Source,
        };
        Self {
            state,
            editor: MarkdownEditor::new(&loaded.markdown),
            persisted_markdown: loaded.markdown,
            pane_mode,
            vim_enabled: false,
            vim_mode: VimMode::Insert,
            status: "Ready".into(),
            proof_url: None,
            proof_status: None,
        }
    }

    fn persist(&mut self) {
        let md = self.editor.to_markdown();
        let state = EditorDocumentState {
            markdown: md.clone(),
            cursor: 0,
            mode: match self.pane_mode {
                PaneMode::Split => EditorMode::Split,
                PaneMode::Source => EditorMode::Source,
            },
        };
        match editor::save_editor_state_to_disk(&state) {
            Ok(()) => {
                self.persisted_markdown = md;
                self.status = "Saved".into();
            }
            Err(err) => self.status = format!("Save failed: {err}"),
        }
    }

    fn hid_active(&self) -> bool {
        self.state.hid_active.load(Ordering::Acquire)
    }

    fn consume_builtin_keydowns(&self, count: usize) -> bool {
        for _ in 0..count {
            let prev = self.state.pending_builtin_keydowns.fetch_sub(1, Ordering::SeqCst);
            if prev <= 0 {
                self.state.pending_builtin_keydowns.store(0, Ordering::SeqCst);
                return false;
            }
        }
        true
    }

    fn frame_input_allowed(&self, ctx: &egui::Context) -> bool {
        if !self.hid_active() {
            return false;
        }

        let mut allowed = true;
        ctx.input(|i| {
            for event in &i.events {
                match event {
                    egui::Event::Text(text) if !text.is_empty() => {
                        if !self.consume_builtin_keydowns(text.chars().count().max(1)) {
                            allowed = false;
                            break;
                        }
                    }
                    egui::Event::Key { pressed: true, key, .. }
                        if matches!(
                            key,
                            egui::Key::Backspace
                                | egui::Key::Delete
                                | egui::Key::Enter
                                | egui::Key::Tab
                                | egui::Key::ArrowLeft
                                | egui::Key::ArrowRight
                                | egui::Key::ArrowUp
                                | egui::Key::ArrowDown
                                | egui::Key::Home
                                | egui::Key::End
                        ) =>
                    {
                        if !self.consume_builtin_keydowns(1) {
                            allowed = false;
                            break;
                        }
                    }
                    _ => {}
                }
            }
        });
        allowed
    }

    fn top_bar(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.heading("HumanProof Native");
                ui.separator();

                if self.hid_active() {
                    ui.label("Built-in keyboard only");
                } else {
                    ui.colored_label(egui::Color32::from_rgb(180, 60, 60), "Input Monitoring Required");
                }

                if ui.button(match self.pane_mode {
                    PaneMode::Split => "Show Source Only",
                    PaneMode::Source => "Show Split Preview",
                }).clicked() {
                    self.pane_mode = match self.pane_mode {
                        PaneMode::Split => PaneMode::Source,
                        PaneMode::Source => PaneMode::Split,
                    };
                }

                if ui.button(if self.vim_enabled {
                    match self.vim_mode {
                        VimMode::Insert => "Vim Insert",
                        VimMode::Normal => "Vim Normal",
                    }
                } else { "Vim Off" }).clicked() {
                    self.vim_enabled = !self.vim_enabled;
                    self.vim_mode = if self.vim_enabled { VimMode::Normal } else { VimMode::Insert };
                }

                if ui.button("Save").clicked() {
                    self.persist();
                }

                if ui.button("Publish Proof").clicked() {
                    let doc_text = self.editor.to_markdown();
                    match humanproof_lib::upload::upload_proof_native(&self.state, &doc_text) {
                        Ok(url) => {
                            self.proof_url = Some(url.clone());
                            self.proof_status = Some(format!("Proof: {url}"));
                        }
                        Err(e) => {
                            self.proof_status = Some(format!("Upload failed: {e}"));
                        }
                    }
                }
                if let Some(ref status) = self.proof_status {
                    ui.label(status);
                }

                ui.separator();
                let md = self.editor.to_markdown();
                ui.label(format!("Mode: {}", self.pane_mode.label()));
                ui.label(format!("Chars: {}", md.chars().count()));
                ui.label(format!("Words: {}", md.split_whitespace().count()));
                if self.vim_enabled {
                    ui.label(match self.vim_mode {
                        VimMode::Insert => "Insert",
                        VimMode::Normal => "Normal",
                    });
                }
                ui.separator();
                ui.label(&self.status);
            });
        });
    }

    fn editor_pane(&mut self, ui: &mut egui::Ui) {
        let hid_ok = self.frame_input_allowed(ui.ctx());
        let changed = self.editor.show(ui, hid_ok);
        if changed {
            self.status = "Edited".into();
        }
    }

    fn preview_pane(&self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().show(ui, |ui| {
            render_markdown_preview(ui, &self.editor.to_markdown());
        });
    }
}

impl eframe::App for NativeEditorApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let current_md = self.editor.to_markdown();
        if current_md != self.persisted_markdown {
            self.persist();
        }
        self.top_bar(ctx);

        egui::CentralPanel::default().show(ctx, |ui| match self.pane_mode {
            PaneMode::Source => {
                self.editor_pane(ui);
            }
            PaneMode::Split => {
                ui.columns(2, |columns| {
                    self.editor_pane(&mut columns[0]);
                    self.preview_pane(&mut columns[1]);
                });
            }
        });
    }
}

fn render_markdown_preview(ui: &mut egui::Ui, markdown: &str) {
    let parser = Parser::new_ext(markdown, Options::all());
    let mut list_depth = 0usize;
    let mut in_code_block = false;
    let mut current_text = String::new();
    let mut heading_level: Option<HeadingLevel> = None;
    let mut quote_depth = 0usize;

    let flush = |ui: &mut egui::Ui,
                 text: &mut String,
                 heading_level: Option<HeadingLevel>,
                 list_depth: usize,
                 quote_depth: usize,
                 in_code_block: bool| {
        if text.trim().is_empty() {
            text.clear();
            return;
        }

        let display = if in_code_block {
            egui::RichText::new(text.clone()).monospace()
        } else {
            match heading_level {
                Some(HeadingLevel::H1) => egui::RichText::new(text.clone()).heading().strong(),
                Some(HeadingLevel::H2) => egui::RichText::new(text.clone()).size(24.0).strong(),
                Some(HeadingLevel::H3) => egui::RichText::new(text.clone()).size(20.0).strong(),
                Some(_) => egui::RichText::new(text.clone()).strong(),
                None => egui::RichText::new(text.clone()),
            }
        };

        ui.horizontal_wrapped(|ui| {
            if quote_depth > 0 {
                ui.label(egui::RichText::new("▌").weak());
            }
            if list_depth > 0 && heading_level.is_none() && !in_code_block {
                ui.label("•");
            }
            ui.label(display);
        });
        ui.add_space(6.0);
        text.clear();
    };

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                heading_level = Some(level);
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                heading_level = None;
            }
            Event::Start(Tag::List(_)) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                list_depth += 1;
            }
            Event::End(TagEnd::List(_)) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                list_depth = list_depth.saturating_sub(1);
            }
            Event::Start(Tag::Item) => {}
            Event::End(TagEnd::Item) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
            }
            Event::Start(Tag::BlockQuote(_)) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                quote_depth += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                quote_depth = quote_depth.saturating_sub(1);
            }
            Event::Start(Tag::CodeBlock(_)) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                in_code_block = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                in_code_block = false;
            }
            Event::SoftBreak | Event::HardBreak => current_text.push('\n'),
            Event::Rule => {
                flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
                ui.separator();
            }
            Event::Code(code) => {
                current_text.push('`');
                current_text.push_str(&code);
                current_text.push('`');
            }
            Event::Text(text) => current_text.push_str(&text),
            Event::Html(text) | Event::InlineHtml(text) => current_text.push_str(&text),
            Event::InlineMath(text) | Event::DisplayMath(text) => current_text.push_str(&text),
            Event::FootnoteReference(text) => current_text.push_str(&format!("[{text}]")),
            Event::TaskListMarker(done) => current_text.push_str(if done { "[x] " } else { "[ ] " }),
            _ => {}
        }
    }

    flush(ui, &mut current_text, heading_level, list_depth, quote_depth, in_code_block);
}
