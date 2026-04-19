use egui::text::{CCursor, CCursorRange};
use egui::{Event, Key, Modifiers};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VimMode {
    Normal,
    Insert,
    Visual,
    CommandLine,
}

impl Default for VimMode {
    fn default() -> Self {
        Self::Normal
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    Delete,
    Change,
    Yank,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingAction {
    None,
    FindForward,
    FindBackward,
    TillForward,
    TillBackward,
    TextObjectInner,
    TextObjectA,
    Register,
    Mark,
    Jump,
    MacroRecord,
    MacroPlayback,
    WaitG,
}

impl Default for PendingAction {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone)]
pub struct VimState {
    pub mode: VimMode,
    pub visual_line: bool,
    pub pending_operator: Option<Operator>,
    pub pending_count: usize,
    pub pending_replace: bool,
    pub pending_action: PendingAction,
    pub last_find: Option<(PendingAction, char)>,

    // Registers and Macros
    pub registers: HashMap<char, String>,
    pub pending_register: Option<char>, // active for the next yank/put
    pub macros: HashMap<char, Vec<Event>>,
    pub recording_macro: Option<char>,
    pub pending_visual_exit: bool,
    pub last_change: Vec<Event>,

    // Marks
    pub marks: HashMap<char, usize>,

    // Command Line & Search
    pub command_prefix: char,
    pub command_buffer: String,
    pub last_search: String,
    pub save_requested: bool,
    pub yank_buffer: String,
    pub yank_is_linewise: bool,

    last_change_recording: Option<Vec<Event>>,
    last_change_output: Vec<Event>,
    last_change_dirty: bool,
    replaying_last_change: bool,
}

impl Default for VimState {
    fn default() -> Self {
        Self {
            mode: VimMode::Normal,
            visual_line: false,
            pending_operator: None,
            pending_count: 0,
            pending_replace: false,
            pending_action: PendingAction::None,
            last_find: None,
            registers: HashMap::new(),
            pending_register: None,
            macros: HashMap::new(),
            recording_macro: None,
            pending_visual_exit: false,
            last_change: Vec::new(),
            marks: HashMap::new(),
            command_prefix: ':',
            command_buffer: String::new(),
            last_search: String::new(),
            save_requested: false,
            yank_buffer: String::new(),
            yank_is_linewise: false,
            last_change_recording: None,
            last_change_output: Vec::new(),
            last_change_dirty: false,
            replaying_last_change: false,
        }
    }
}

impl VimState {
    pub fn new() -> Self {
        Self::default()
    }

    fn consume_count(&mut self) -> usize {
        let c = if self.pending_count > 0 {
            self.pending_count
        } else {
            1
        };
        self.pending_count = 0;
        c
    }

    fn active_register(&mut self) -> char {
        self.pending_register.take().unwrap_or('"')
    }

    fn begin_last_change_recording(&mut self) {
        if self.replaying_last_change || self.last_change_recording.is_some() {
            return;
        }
        self.last_change_recording = Some(Vec::new());
        self.last_change_output.clear();
        self.last_change_dirty = false;
    }

    fn record_last_change_input(&mut self, event: &Event) {
        if self.replaying_last_change {
            return;
        }
        if let Some(recording) = self.last_change_recording.as_mut() {
            recording.push(event.clone());
        }
    }

    fn note_last_change_output(&mut self, out: &[Event]) {
        if self.replaying_last_change || self.last_change_recording.is_none() {
            return;
        }

        if out.iter().any(|event| match event {
            Event::Text(_) | Event::Paste(_) => true,
            Event::Key { key, pressed: true, .. } => matches!(key, Key::Backspace | Key::Enter),
            _ => false,
        }) {
            self.last_change_dirty = true;
            self.last_change_output.extend(out.iter().cloned());
        }
    }

    fn finish_last_change_recording_if_ready(&mut self) {
        if self.replaying_last_change {
            return;
        }

        let ready = self.last_change_recording.is_some()
            && self.pending_operator.is_none()
            && self.pending_action == PendingAction::None
            && !self.pending_replace
            && self.mode == VimMode::Normal;
        if !ready {
            return;
        }

        if let Some(recording) = self.last_change_recording.take() {
            if self.last_change_dirty {
                self.last_change = recording;
            } else {
                self.last_change_output.clear();
            }
        }
        self.last_change_dirty = false;
    }

    fn replay_last_change(
        &mut self,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        if self.last_change_output.is_empty() {
            return Vec::new();
        }

        let _ = (text, te_state);
        self.last_change_output.clone()
    }

    pub fn handle_event(
        &mut self,
        event: &Event,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        self.handle_event_impl(event, text, te_state, true)
    }

    fn handle_event_impl(
        &mut self,
        event: &Event,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
        record_macro: bool,
    ) -> Vec<Event> {
        self.record_last_change_input(event);

        if record_macro {
            if let Some(r) = self.recording_macro {
                // don't record the 'q' key that stops recording
                let mut is_stop_record = false;
                if self.mode == VimMode::Normal {
                    if let Event::Text(t) = event {
                        if t == "q" {
                            is_stop_record = true;
                        }
                    }
                }
                if !is_stop_record {
                    self.macros.entry(r).or_default().push(event.clone());
                }
            }
        }

        match self.mode {
            VimMode::Normal => self.handle_normal(event, text, te_state),
            VimMode::Insert => self.handle_insert(event),
            VimMode::Visual => self.handle_visual(event, text, te_state),
            VimMode::CommandLine => self.handle_command_line(event, text, te_state),
        }
    }

    fn handle_normal(
        &mut self,
        event: &Event,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        match event {
            // Consume both press and release of Escape so egui never sees it and
            // drops focus from the TextEdit.
            Event::Key {
                key: Key::Escape, ..
            } => {
                // Only act on press; release is silently consumed.
                if let Event::Key { pressed: true, .. } = event {
                    self.pending_operator = None;
                    self.pending_count = 0;
                    self.pending_replace = false;
                    self.pending_action = PendingAction::None;
                    self.pending_register = None;
                }
                return out;
            }
            Event::Key {
                key,
                pressed: true,
                modifiers,
                ..
            } => {
                if modifiers.ctrl || modifiers.command {
                    if *key == Key::R {
                        out.push(Self::key_event(
                            Key::Z,
                            Modifiers::SHIFT | Modifiers::MAC_CMD,
                        ));
                        return out;
                    }
                    // Page Navigation logic
                    if *key == Key::D {
                        out.push(Self::key_event(Key::PageDown, Modifiers::NONE));
                        return out;
                    }
                    if *key == Key::U {
                        out.push(Self::key_event(Key::PageUp, Modifiers::NONE));
                        return out;
                    }
                    if *key == Key::F {
                        out.push(Self::key_event(Key::PageDown, Modifiers::NONE));
                        return out;
                    }
                    if *key == Key::B {
                        out.push(Self::key_event(Key::PageUp, Modifiers::NONE));
                        return out;
                    }

                    out.push(event.clone());
                    return out;
                }
            }
            Event::Text(t) => {
                out.extend(self.process_normal_text_command(t.as_str(), text, te_state));
                return out;
            }
            _ => {
                out.push(event.clone());
            }
        }
        out
    }

    fn is_escape_like(event: &Event) -> bool {
        match event {
            Event::Key {
                key: Key::Escape, ..
            } => true,
            Event::Key {
                key: Key::OpenBracket,
                modifiers,
                pressed: true,
                ..
            } => modifiers.ctrl,
            _ => false,
        }
    }

    fn handle_insert(&mut self, event: &Event) -> Vec<Event> {
        let mut out = Vec::new();
        let is_esc = Self::is_escape_like(event);
        if is_esc {
            // Consume both press and release; switch to Normal on press only.
            if let Event::Key { pressed: true, .. } = event {
                self.mode = VimMode::Normal;
                self.finish_last_change_recording_if_ready();
            }
        } else {
            out.push(event.clone());
        }
        out
    }

    fn handle_visual(
        &mut self,
        event: &Event,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        if Self::is_escape_like(event) {
            if let Event::Key { pressed: true, .. } = event {
                self.exit_visual_mode(te_state, false);
            }
            return out;
        }
        match event {
            Event::Text(t) => {
                out.extend(self.process_visual_text_command(t.as_str(), text, te_state));
            }
            Event::Key {
                key,
                pressed: true,
                modifiers,
                ..
            } => {
                if *key == Key::Escape {
                    return vec![];
                }
                if modifiers.ctrl || modifiers.command {
                    out.push(event.clone());
                }
            }
            _ => {
                out.push(event.clone());
            }
        }
        out
    }

    fn handle_command_line(
        &mut self,
        event: &Event,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        if Self::is_escape_like(event) {
            if let Event::Key { pressed: true, .. } = event {
                self.mode = VimMode::Normal;
                self.command_buffer.clear();
            }
            return out;
        }
        match event {
            Event::Key {
                key: Key::Backspace,
                pressed: true,
                ..
            } => {
                if self.command_buffer.is_empty() {
                    self.mode = VimMode::Normal;
                } else {
                    self.command_buffer.pop();
                }
            }
            Event::Key {
                key: Key::Enter,
                pressed: true,
                ..
            } => {
                self.mode = VimMode::Normal;

                if self.command_prefix == ':' {
                    let cmd = self.command_buffer.trim();
                    if matches!(cmd, "w" | "wq" | "x") {
                        self.save_requested = true;
                    }
                } else if self.command_prefix == '/' || self.command_prefix == '?' {
                    if !self.command_buffer.is_empty() {
                        self.last_search = self.command_buffer.clone();
                        out.extend(self.perform_search(
                            &self.last_search,
                            self.command_prefix == '/',
                            text,
                            te_state,
                        ));
                    }
                }

                self.command_buffer.clear();
            }
            Event::Text(t) => {
                self.command_buffer.push_str(t);
            }
            _ => {}
        }
        out
    }

    fn perform_search(
        &self,
        query: &str,
        forward: bool,
        text: &str,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        if query.is_empty() {
            return vec![];
        }
        let c_idx = Self::get_cursor_char_idx(te_state);
        let mut target = None;

        let chars: Vec<char> = text.chars().collect();
        let q_chars: Vec<char> = query.chars().collect();

        if forward {
            for i in c_idx + 1..chars.len() {
                if i + q_chars.len() <= chars.len()
                    && chars.windows(q_chars.len()).nth(i).unwrap() == q_chars.as_slice()
                {
                    target = Some(i);
                    break;
                }
            }
            if target.is_none() {
                // wrap
                for i in 0..c_idx {
                    if i + q_chars.len() <= chars.len()
                        && chars.windows(q_chars.len()).nth(i).unwrap() == q_chars.as_slice()
                    {
                        target = Some(i);
                        break;
                    }
                }
            }
        } else {
            for i in (0..c_idx).rev() {
                if i + q_chars.len() <= chars.len()
                    && chars.windows(q_chars.len()).nth(i).unwrap() == q_chars.as_slice()
                {
                    target = Some(i);
                    break;
                }
            }
        }

        if let Some(idx) = target {
            Self::set_cursor_char_idx(te_state, idx);
        }
        vec![]
    }

    fn get_cursor_char_idx(te_state: &egui::widgets::text_edit::TextEditState) -> usize {
        te_state
            .cursor
            .char_range()
            .map(|r| r.primary.index)
            .unwrap_or(0)
    }

    fn get_cursor_anchor(te_state: &egui::widgets::text_edit::TextEditState) -> usize {
        te_state
            .cursor
            .char_range()
            .map(|r| r.secondary.index)
            .unwrap_or(0)
    }

    fn set_cursor_char_idx(te_state: &mut egui::widgets::text_edit::TextEditState, idx: usize) {
        if let Some(mut r) = te_state.cursor.char_range() {
            r.primary.index = idx;
            r.secondary = r.primary;
            te_state.cursor.set_char_range(Some(r));
        } else {
            let r = CCursorRange::two(CCursor::new(idx), CCursor::new(idx));
            te_state.cursor.set_char_range(Some(r));
        }
    }

    fn set_selection(
        te_state: &mut egui::widgets::text_edit::TextEditState,
        start: usize,
        end: usize,
    ) {
        let r = CCursorRange::two(CCursor::new(start), CCursor::new(end));
        te_state.cursor.set_char_range(Some(r));
    }

    fn enter_visual_mode(
        &mut self,
        text: &str,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) {
        self.mode = VimMode::Visual;
        self.visual_line = false;

        let idx = Self::get_cursor_char_idx(te_state);
        let len = text.chars().count();
        if idx < len {
            Self::set_selection(te_state, idx, idx + 1);
        } else {
            Self::set_cursor_char_idx(te_state, idx);
        }
    }

    fn enter_visual_line_mode(
        &mut self,
        text: &str,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) {
        self.mode = VimMode::Visual;
        self.visual_line = true;

        let idx = Self::get_cursor_char_idx(te_state);
        let line_start = Self::line_start_idx(text, idx);
        Self::set_visual_line_selection(te_state, text, line_start, line_start);
    }

    fn exit_visual_mode(
        &mut self,
        te_state: &mut egui::widgets::text_edit::TextEditState,
        keep_cursor_position: bool,
    ) {
        if let Some(range) = te_state.cursor.char_range() {
            let [start, end] = range.sorted();
            let target = if keep_cursor_position {
                Self::get_visual_cursor_char_idx(te_state)
            } else if start.index == end.index {
                start.index
            } else {
                start.index
            };
            Self::set_cursor_char_idx(te_state, target);
        }
        self.mode = VimMode::Normal;
        self.visual_line = false;
    }

    fn get_visual_anchor_and_cursor(
        te_state: &egui::widgets::text_edit::TextEditState,
    ) -> Option<(usize, usize)> {
        let range = te_state.cursor.char_range()?;
        if range.primary.index >= range.secondary.index {
            Some((range.secondary.index, range.primary.index.saturating_sub(1)))
        } else {
            Some((range.secondary.index.saturating_sub(1), range.primary.index))
        }
    }

    fn get_visual_cursor_char_idx(te_state: &egui::widgets::text_edit::TextEditState) -> usize {
        Self::get_visual_anchor_and_cursor(te_state)
            .map(|(_, cursor)| cursor)
            .unwrap_or_else(|| Self::get_cursor_char_idx(te_state))
    }

    fn set_visual_selection(
        te_state: &mut egui::widgets::text_edit::TextEditState,
        anchor: usize,
        cursor: usize,
    ) {
        if cursor >= anchor {
            Self::set_selection(te_state, anchor, cursor + 1);
        } else {
            Self::set_selection(te_state, anchor + 1, cursor);
        }
    }

    fn next_line_start_idx(text: &str, idx: usize) -> usize {
        let len = text.chars().count();
        let line_end = Self::line_end_idx(text, idx.min(len));
        if line_end < len {
            line_end + 1
        } else {
            len
        }
    }

    fn prev_line_start_idx(text: &str, idx: usize) -> usize {
        let line_start = Self::line_start_idx(text, idx);
        if line_start == 0 {
            0
        } else {
            Self::line_start_idx(text, line_start.saturating_sub(1))
        }
    }

    fn set_visual_line_selection(
        te_state: &mut egui::widgets::text_edit::TextEditState,
        text: &str,
        anchor_line_start: usize,
        cursor_line_start: usize,
    ) {
        let start = anchor_line_start.min(cursor_line_start);
        let end_line_start = anchor_line_start.max(cursor_line_start);
        let end = Self::next_line_start_idx(text, end_line_start);
        Self::set_selection(te_state, start, end);
    }

    fn visual_line_anchor_and_cursor(
        &self,
        text: &str,
        te_state: &egui::widgets::text_edit::TextEditState,
    ) -> Option<(usize, usize)> {
        if self.mode != VimMode::Visual || !self.visual_line {
            return None;
        }

        let (start, end) = Self::selection_bounds(te_state)?;
        let anchor = Self::line_start_idx(text, Self::get_cursor_anchor(te_state));
        let cursor = if anchor == start {
            Self::line_start_idx(text, end.saturating_sub(1))
        } else {
            start
        };
        Some((anchor, cursor))
    }

    fn set_motion_target(
        &self,
        te_state: &mut egui::widgets::text_edit::TextEditState,
        target: usize,
    ) {
        let anchor = Self::get_cursor_anchor(te_state);
        if self.mode == VimMode::Visual || self.pending_operator.is_some() {
            Self::set_selection(te_state, anchor, target);
        } else {
            Self::set_cursor_char_idx(te_state, target);
        }
    }

    fn selection_bounds(
        te_state: &egui::widgets::text_edit::TextEditState,
    ) -> Option<(usize, usize)> {
        let range = te_state.cursor.char_range()?;
        let [start, end] = range.sorted();
        Some((start.index, end.index))
    }

    fn extract_range(text: &str, start: usize, end: usize) -> String {
        text.chars()
            .skip(start)
            .take(end.saturating_sub(start))
            .collect()
    }

    fn selected_text(
        text: &str,
        te_state: &egui::widgets::text_edit::TextEditState,
    ) -> Option<String> {
        let (start, end) = Self::selection_bounds(te_state)?;
        if start >= end {
            return None;
        }
        Some(Self::extract_range(text, start, end))
    }

    fn store_yank_text(&mut self, content: String) {
        self.yank_buffer = content.clone();
        if let Some(reg) = self.pending_register.take() {
            if reg != '"' {
                self.registers.insert(reg, content);
            }
        }
    }

    fn register_contents(&self, reg: char) -> String {
        if reg == '"' {
            self.yank_buffer.clone()
        } else {
            self.registers.get(&reg).cloned().unwrap_or_default()
        }
    }

    pub(crate) fn flush_pending_visual_exit(
        &mut self,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) {
        if self.pending_visual_exit {
            self.pending_visual_exit = false;
            self.exit_visual_mode(te_state, false);
        }
    }

    fn is_small_word_char(ch: char) -> bool {
        ch.is_alphanumeric() || ch == '_'
    }

    fn small_word_class(ch: char) -> u8 {
        if ch.is_whitespace() {
            0
        } else if Self::is_small_word_char(ch) {
            1
        } else {
            2
        }
    }

    fn move_word_motion(
        &mut self,
        motion: char,
        text: &str,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let chars: Vec<char> = text.chars().collect();
        let len = chars.len();
        let count = self.consume_count();
        let mut idx = Self::get_cursor_char_idx(te_state).min(len);
        let selecting = self.mode == VimMode::Visual || self.pending_operator.is_some();
        let mut out = Vec::new();

        for _ in 0..count {
            idx = match motion {
                'w' => Self::next_word_start(&chars, idx, false),
                'W' => Self::next_word_start(&chars, idx, true),
                'b' => Self::prev_word_start(&chars, idx, false),
                'B' => Self::prev_word_start(&chars, idx, true),
                'e' => Self::word_end(&chars, idx, false),
                'E' => Self::word_end(&chars, idx, true),
                _ => idx,
            };
        }

        if selecting {
            let modifiers = Modifiers::ALT | Modifiers::SHIFT;
            let key = match motion {
                'w' | 'W' | 'e' | 'E' => Key::ArrowRight,
                'b' | 'B' => Key::ArrowLeft,
                _ => Key::ArrowRight,
            };
            for _ in 0..count {
                out.push(Self::key_event(key, modifiers));
            }
        }

        if self.mode == VimMode::Visual {
            let anchor = Self::get_visual_anchor_and_cursor(te_state)
                .map(|(visual_anchor, _)| visual_anchor)
                .unwrap_or_else(|| Self::get_cursor_char_idx(te_state));
            if matches!(motion, 'e' | 'E') {
                Self::set_visual_selection(te_state, anchor, idx);
            } else {
                Self::set_selection(te_state, anchor, idx);
            }
        } else if self.pending_operator.is_some() && matches!(motion, 'e' | 'E') {
            let anchor = Self::get_cursor_anchor(te_state);
            Self::set_visual_selection(te_state, anchor, idx);
        } else {
            self.set_motion_target(te_state, idx);
        }
        if let Some(op) = self.pending_operator {
            out.extend(self.apply_operator(op, text, te_state));
        }
        out
    }

    fn line_start_idx(text: &str, idx: usize) -> usize {
        text.chars()
            .take(idx)
            .collect::<Vec<_>>()
            .iter()
            .rposition(|&c| c == '\n')
            .map(|i| i + 1)
            .unwrap_or(0)
    }

    fn line_end_idx(text: &str, idx: usize) -> usize {
        let len = text.chars().count();
        let line_start = Self::line_start_idx(text, idx.min(len));
        text.chars()
            .skip(line_start)
            .position(|c| c == '\n')
            .map(|offset| line_start + offset)
            .unwrap_or(len)
    }

    fn apply_visual_motion(
        &mut self,
        motion: &str,
        text: &str,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Option<Vec<Event>> {
        if self.mode != VimMode::Visual {
            return None;
        }

        if self.visual_line {
            let count = self.consume_count();
            let (anchor_line, mut cursor_line) =
                self.visual_line_anchor_and_cursor(text, te_state)?;

            match motion {
                "j" => {
                    for _ in 0..count {
                        let next = Self::next_line_start_idx(text, cursor_line);
                        if next == cursor_line {
                            break;
                        }
                        cursor_line = next;
                    }
                }
                "k" => {
                    for _ in 0..count {
                        let prev = Self::prev_line_start_idx(text, cursor_line);
                        if prev == cursor_line {
                            break;
                        }
                        cursor_line = prev;
                    }
                }
                "0" | "$" | "h" | "l" => {}
                _ => return None,
            }

            Self::set_visual_line_selection(te_state, text, anchor_line, cursor_line);
            return Some(Vec::new());
        }

        let len = text.chars().count();
        if len == 0 {
            return Some(Vec::new());
        }
        let count = self.consume_count();
        let (anchor, cursor) = Self::get_visual_anchor_and_cursor(te_state)?;
        let mut idx = cursor.min(len.saturating_sub(1));

        match motion {
            "h" => {
                idx = idx.saturating_sub(count);
            }
            "l" => {
                idx = (idx + count).min(len.saturating_sub(1));
            }
            "0" => {
                idx = Self::line_start_idx(text, idx);
            }
            "$" => {
                idx = Self::line_end_idx(text, idx).saturating_sub(1);
            }
            _ => return None,
        }

        Self::set_visual_selection(te_state, anchor, idx);
        Some(Vec::new())
    }

    fn next_word_start(chars: &[char], idx: usize, big: bool) -> usize {
        if chars.is_empty() {
            return 0;
        }
        let len = chars.len();
        let mut i = idx.min(len);
        if i >= len {
            return len;
        }
        if chars[i].is_whitespace() {
            while i < len && chars[i].is_whitespace() {
                i += 1;
            }
            return i.min(len);
        }
        if big {
            while i < len && !chars[i].is_whitespace() {
                i += 1;
            }
        } else {
            let class = Self::small_word_class(chars[i]);
            while i < len && Self::small_word_class(chars[i]) == class && !chars[i].is_whitespace()
            {
                i += 1;
            }
        }
        while i < len && chars[i].is_whitespace() {
            i += 1;
        }
        i.min(len)
    }

    fn prev_word_start(chars: &[char], idx: usize, big: bool) -> usize {
        if chars.is_empty() {
            return 0;
        }
        let mut i = idx.min(chars.len());
        i = i.saturating_sub(1);
        while i > 0 && chars[i].is_whitespace() {
            i -= 1;
        }
        if big {
            while i > 0 && !chars[i - 1].is_whitespace() {
                i -= 1;
            }
            return i;
        }
        let class = Self::small_word_class(chars[i]);
        while i > 0
            && Self::small_word_class(chars[i - 1]) == class
            && !chars[i - 1].is_whitespace()
        {
            i -= 1;
        }
        i
    }

    fn word_end(chars: &[char], idx: usize, big: bool) -> usize {
        if chars.is_empty() {
            return 0;
        }
        let len = chars.len();
        let mut i = idx.min(len.saturating_sub(1));

        let same_group = |left: char, right: char| {
            if big {
                !left.is_whitespace() && !right.is_whitespace()
            } else {
                !left.is_whitespace()
                    && !right.is_whitespace()
                    && Self::small_word_class(left) == Self::small_word_class(right)
            }
        };

        if chars[i].is_whitespace() {
            if let Some(next) = (i..len).find(|&j| !chars[j].is_whitespace()) {
                i = next;
            } else {
                return chars
                    .iter()
                    .rposition(|c| !c.is_whitespace())
                    .unwrap_or(len.saturating_sub(1));
            }
        }

        let mut end = i;
        while end + 1 < len && same_group(chars[end], chars[end + 1]) {
            end += 1;
        }

        if idx.min(len.saturating_sub(1)) == end {
            let mut next = end + 1;
            while next < len && chars[next].is_whitespace() {
                next += 1;
            }
            if next < len {
                let mut next_end = next;
                while next_end + 1 < len && same_group(chars[next_end], chars[next_end + 1]) {
                    next_end += 1;
                }
                return next_end;
            }
        }

        end
    }

    fn prev_word_end(chars: &[char], idx: usize, big: bool) -> usize {
        if chars.is_empty() {
            return 0;
        }

        let len = chars.len();
        let cursor = idx.min(len);
        if cursor == 0 {
            return 0;
        }
        let mut i = cursor - 1;

        while i > 0 && chars[i].is_whitespace() {
            i -= 1;
        }

        let same_group = |left: char, right: char| {
            if big {
                !left.is_whitespace() && !right.is_whitespace()
            } else {
                !left.is_whitespace()
                    && !right.is_whitespace()
                    && Self::small_word_class(left) == Self::small_word_class(right)
            }
        };

        let in_current_word = if cursor < len && !chars[cursor].is_whitespace() && cursor > 0 {
            same_group(chars[cursor - 1], chars[cursor])
        } else {
            false
        };

        if in_current_word {
            while i > 0 && same_group(chars[i - 1], chars[i]) {
                i -= 1;
            }
            if i == 0 {
                return 0;
            }
            i -= 1;
            while i > 0 && chars[i].is_whitespace() {
                i -= 1;
            }
        }

        i
    }

    fn word_under_cursor(text: &str, idx: usize) -> Option<String> {
        let chars: Vec<char> = text.chars().collect();
        if chars.is_empty() {
            return None;
        }

        let mut i = idx.min(chars.len().saturating_sub(1));
        if chars[i].is_whitespace() {
            if let Some(next) = (i + 1..chars.len()).find(|&j| Self::is_small_word_char(chars[j])) {
                i = next;
            } else if let Some(prev) = (0..i).rev().find(|&j| Self::is_small_word_char(chars[j])) {
                i = prev;
            } else {
                return None;
            }
        }

        if !Self::is_small_word_char(chars[i]) {
            return None;
        }

        let mut start = i;
        while start > 0 && Self::is_small_word_char(chars[start - 1]) {
            start -= 1;
        }
        let mut end = i + 1;
        while end < chars.len() && Self::is_small_word_char(chars[end]) {
            end += 1;
        }
        Some(Self::extract_range(text, start, end))
    }

    fn find_matching_delimiter(text: &str, idx: usize) -> Option<usize> {
        let chars: Vec<char> = text.chars().collect();
        let ch = *chars.get(idx)?;
        let (open, close, forward) = match ch {
            '(' => ('(', ')', true),
            '[' => ('[', ']', true),
            '{' => ('{', '}', true),
            ')' => ('(', ')', false),
            ']' => ('[', ']', false),
            '}' => ('{', '}', false),
            _ => return None,
        };

        let mut depth = 0usize;
        if forward {
            for (i, c) in chars.iter().enumerate().skip(idx + 1) {
                if *c == open {
                    depth += 1;
                } else if *c == close {
                    if depth == 0 {
                        return Some(i);
                    }
                    depth -= 1;
                }
            }
        } else {
            for i in (0..idx).rev() {
                if chars[i] == close {
                    depth += 1;
                } else if chars[i] == open {
                    if depth == 0 {
                        return Some(i);
                    }
                    depth -= 1;
                }
            }
        }
        None
    }

    fn next_paragraph_boundary(text: &str, idx: usize) -> usize {
        let chars: Vec<char> = text.chars().collect();
        if chars.len() < 2 {
            return chars.len();
        }
        for i in idx.min(chars.len().saturating_sub(1))..chars.len() - 1 {
            if chars[i] == '\n' && chars[i + 1] == '\n' {
                return (i + 2).min(chars.len());
            }
        }
        chars.len()
    }

    fn prev_paragraph_boundary(text: &str, idx: usize) -> usize {
        let chars: Vec<char> = text.chars().collect();
        if chars.len() < 2 {
            return 0;
        }
        let mut i = idx.min(chars.len()).saturating_sub(1);
        while i > 0 {
            if chars[i - 1] == '\n' && chars[i] == '\n' {
                return i;
            }
            i -= 1;
        }
        0
    }

    fn process_normal_text_command(
        &mut self,
        cmd: &str,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        for ch in cmd.chars() {
            if self.pending_replace {
                out.push(Self::key_event(Key::ArrowRight, Modifiers::SHIFT));
                out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                out.push(Event::Text(ch.to_string()));
                self.pending_replace = false;
                continue;
            }

            if self.pending_action != PendingAction::None {
                out.extend(self.handle_pending_action(ch, text, te_state));
                continue;
            }

            if ch.is_ascii_digit() {
                if ch == '0' && self.pending_count == 0 {
                    out.extend(self.apply_motion("0", text, te_state));
                    continue;
                } else {
                    let val = ch.to_digit(10).unwrap() as usize;
                    self.pending_count = self.pending_count * 10 + val;
                    continue;
                }
            }

            match ch {
                ':' | '/' | '?' => {
                    self.mode = VimMode::CommandLine;
                    self.command_prefix = ch;
                    self.command_buffer.clear();
                }
                'n' => {
                    out.extend(self.perform_search(
                        &self.last_search.clone(),
                        true,
                        text,
                        te_state,
                    ));
                }
                'N' => {
                    out.extend(self.perform_search(
                        &self.last_search.clone(),
                        false,
                        text,
                        te_state,
                    ));
                }
                'q' => {
                    if self.recording_macro.is_some() {
                        self.recording_macro = None;
                    } else {
                        self.pending_action = PendingAction::MacroRecord;
                    }
                }
                '@' => {
                    self.pending_action = PendingAction::MacroPlayback;
                }
                '"' => {
                    self.pending_action = PendingAction::Register;
                }
                'm' => {
                    self.pending_action = PendingAction::Mark;
                }
                '\'' | '`' => {
                    self.pending_action = PendingAction::Jump;
                }
                'i' => {
                    self.begin_last_change_recording();
                    if self.pending_operator.is_some() {
                        self.pending_action = PendingAction::TextObjectInner;
                    } else {
                        self.mode = VimMode::Insert;
                    }
                }
                'a' => {
                    self.begin_last_change_recording();
                    if self.pending_operator.is_some() {
                        self.pending_action = PendingAction::TextObjectA;
                    } else {
                        out.push(Self::key_event(Key::ArrowRight, Modifiers::NONE));
                        self.mode = VimMode::Insert;
                    }
                }
                'A' => {
                    self.begin_last_change_recording();
                    out.push(Self::key_event(Key::End, Modifiers::NONE));
                    self.mode = VimMode::Insert;
                }
                'C' => {
                    self.begin_last_change_recording();
                    out.push(Self::key_event(Key::End, Modifiers::SHIFT));
                    out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                    self.mode = VimMode::Insert;
                }
                'D' => {
                    self.begin_last_change_recording();
                    out.push(Self::key_event(Key::End, Modifiers::SHIFT));
                    out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                }
                'I' => {
                    self.begin_last_change_recording();
                    out.push(Self::key_event(Key::Home, Modifiers::NONE));
                    self.mode = VimMode::Insert;
                }
                'o' => {
                    self.begin_last_change_recording();
                    out.push(Self::key_event(Key::End, Modifiers::NONE));
                    out.push(Self::key_event(Key::Enter, Modifiers::NONE));
                    self.mode = VimMode::Insert;
                }
                'O' => {
                    self.begin_last_change_recording();
                    out.push(Self::key_event(Key::Home, Modifiers::NONE));
                    out.push(Self::key_event(Key::Enter, Modifiers::NONE));
                    out.push(Self::key_event(Key::ArrowUp, Modifiers::NONE));
                    self.mode = VimMode::Insert;
                }
                'v' => {
                    self.enter_visual_mode(text, te_state);
                }
                'V' => {
                    self.enter_visual_line_mode(text, te_state);
                }
                'x' => {
                    self.begin_last_change_recording();
                    let c = self.consume_count();
                    for _ in 0..c {
                        out.push(Self::key_event(Key::ArrowRight, Modifiers::SHIFT));
                    }
                    out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                }
                'X' => {
                    self.begin_last_change_recording();
                    let c = self.consume_count();
                    for _ in 0..c {
                        out.push(Self::key_event(Key::ArrowLeft, Modifiers::SHIFT));
                    }
                    out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                }
                'r' => {
                    self.begin_last_change_recording();
                    self.pending_replace = true;
                }
                's' => {
                    self.begin_last_change_recording();
                    let c = self.consume_count();
                    for _ in 0..c {
                        out.push(Self::key_event(Key::ArrowRight, Modifiers::SHIFT));
                    }
                    out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                    self.mode = VimMode::Insert;
                }
                'S' => {
                    self.begin_last_change_recording();
                    let c = self.consume_count();
                    for _ in 0..c {
                        out.extend(self.change_line());
                    }
                    self.mode = VimMode::Insert;
                }
                'u' => {
                    out.push(Self::key_event(Key::Z, Modifiers::MAC_CMD));
                }
                '.' => {
                    out.extend(self.replay_last_change(text, te_state));
                }
                'p' => {
                    self.begin_last_change_recording();
                    let reg = self.active_register();
                    let content = self.register_contents(reg);
                    if self.yank_is_linewise {
                        out.push(Self::key_event(Key::End, Modifiers::NONE));
                        out.push(Self::key_event(Key::Enter, Modifiers::NONE));
                    } else {
                        out.push(Self::key_event(Key::ArrowRight, Modifiers::NONE));
                    }
                    out.push(Event::Paste(content));
                    self.yank_is_linewise = false;
                }
                'P' => {
                    self.begin_last_change_recording();
                    let reg = self.active_register();
                    let content = self.register_contents(reg);
                    if self.yank_is_linewise {
                        out.push(Self::key_event(Key::Home, Modifiers::NONE));
                        out.push(Self::key_event(Key::Enter, Modifiers::NONE));
                        out.push(Self::key_event(Key::ArrowUp, Modifiers::NONE));
                    }
                    out.push(Event::Paste(content));
                    self.yank_is_linewise = false;
                }
                'd' => {
                    if self.pending_operator.is_none() {
                        self.begin_last_change_recording();
                    }
                    if let Some(Operator::Delete) = self.pending_operator {
                        let c = self.consume_count();
                        for _ in 0..c {
                            out.extend(self.delete_line());
                        }
                        self.pending_operator = None;
                    } else {
                        self.pending_operator = Some(Operator::Delete);
                    }
                }
                'c' => {
                    if self.pending_operator.is_none() {
                        self.begin_last_change_recording();
                    }
                    if let Some(Operator::Change) = self.pending_operator {
                        let c = self.consume_count();
                        for _ in 0..c {
                            out.extend(self.change_line());
                        }
                        self.mode = VimMode::Insert;
                        self.pending_operator = None;
                    } else {
                        self.pending_operator = Some(Operator::Change);
                    }
                }
                'y' => {
                    if let Some(Operator::Yank) = self.pending_operator {
                        let c = self.consume_count();
                        let line_start =
                            Self::line_start_idx(text, Self::get_cursor_char_idx(te_state));
                        let line_end =
                            Self::line_end_idx(text, Self::get_cursor_char_idx(te_state));
                        self.store_yank_text(Self::extract_range(text, line_start, line_end));
                        self.yank_is_linewise = true;
                        for _ in 0..c {
                            out.extend(self.yank_line());
                        }
                        self.pending_operator = None;
                    } else {
                        self.pending_operator = Some(Operator::Yank);
                    }
                }
                'f' => {
                    self.pending_action = PendingAction::FindForward;
                }
                'F' => {
                    self.pending_action = PendingAction::FindBackward;
                }
                't' => {
                    self.pending_action = PendingAction::TillForward;
                }
                'T' => {
                    self.pending_action = PendingAction::TillBackward;
                }
                ';' => {
                    if let Some((act, last_ch)) = self.last_find {
                        self.pending_action = act;
                        out.extend(self.handle_pending_action(last_ch, text, te_state));
                    }
                }
                ',' => {
                    if let Some((act, last_ch)) = self.last_find {
                        self.pending_action = match act {
                            PendingAction::FindForward => PendingAction::FindBackward,
                            PendingAction::FindBackward => PendingAction::FindForward,
                            PendingAction::TillForward => PendingAction::FindBackward,
                            PendingAction::TillBackward => PendingAction::FindForward,
                            _ => act,
                        };
                        out.extend(self.handle_pending_action(last_ch, text, te_state));
                    }
                }
                '~' => {
                    self.begin_last_change_recording();
                    let c_idx = Self::get_cursor_char_idx(te_state);
                    if let Some(t_char) = text.chars().nth(c_idx) {
                        let toggled = if t_char.is_lowercase() {
                            t_char.to_ascii_uppercase()
                        } else {
                            t_char.to_ascii_lowercase()
                        };
                        out.push(Self::key_event(Key::ArrowRight, Modifiers::SHIFT));
                        out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                        out.push(Event::Text(toggled.to_string()));
                    }
                }
                '^' => {
                    let c_idx = Self::get_cursor_char_idx(te_state);
                    let line_start = text
                        .chars()
                        .take(c_idx)
                        .collect::<Vec<_>>()
                        .iter()
                        .rposition(|&c| c == '\n')
                        .map(|i| i + 1)
                        .unwrap_or(0);
                    let mut target = line_start;
                    for c in text.chars().skip(line_start) {
                        if c != ' ' && c != '\t' {
                            break;
                        }
                        target += 1;
                    }
                    if target >= c_idx {
                        for _ in 0..(target - c_idx) {
                            out.push(Self::key_event(Key::ArrowRight, Modifiers::NONE));
                        }
                    } else {
                        for _ in 0..(c_idx - target) {
                            out.push(Self::key_event(Key::ArrowLeft, Modifiers::NONE));
                        }
                    }
                }
                'W' | 'B' | 'E' => {
                    out.extend(self.move_word_motion(ch, text, te_state));
                }
                'J' => {
                    self.begin_last_change_recording();
                    out.push(Self::key_event(Key::End, Modifiers::NONE));
                    out.push(Self::key_event(Key::ArrowRight, Modifiers::SHIFT));
                    out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                    out.push(Event::Text(" ".to_string()));
                }
                '%' => {
                    let c_idx = Self::get_cursor_char_idx(te_state);
                    if let Some(target) = Self::find_matching_delimiter(text, c_idx) {
                        self.set_motion_target(te_state, target);
                        if let Some(op) = self.pending_operator {
                            out.extend(self.apply_operator(op, text, te_state));
                        }
                    }
                }
                '*' | '#' => {
                    if let Some(query) =
                        Self::word_under_cursor(text, Self::get_cursor_char_idx(te_state))
                    {
                        self.last_search = query.clone();
                        out.extend(self.perform_search(&query, ch == '*', text, te_state));
                    }
                }
                '}' => {
                    let target =
                        Self::next_paragraph_boundary(text, Self::get_cursor_char_idx(te_state));
                    self.set_motion_target(te_state, target);
                    if let Some(op) = self.pending_operator {
                        out.extend(self.apply_operator(op, text, te_state));
                    }
                }
                '{' => {
                    let target =
                        Self::prev_paragraph_boundary(text, Self::get_cursor_char_idx(te_state));
                    self.set_motion_target(te_state, target);
                    if let Some(op) = self.pending_operator {
                        out.extend(self.apply_operator(op, text, te_state));
                    }
                }
                'h' | 'j' | 'k' | 'l' | 'w' | 'b' | 'e' | '$' => {
                    if matches!(ch, 'w' | 'b' | 'e') {
                        out.extend(self.move_word_motion(ch, text, te_state));
                    } else {
                        out.extend(self.apply_motion(&ch.to_string(), text, te_state));
                    }
                }
                'G' => {
                    out.extend(self.apply_g(text, te_state));
                }
                'g' => {
                    self.pending_action = PendingAction::WaitG;
                }
                _ => {}
            }

            self.note_last_change_output(&out);
            self.finish_last_change_recording_if_ready();
        }
        out
    }

    fn process_visual_text_command(
        &mut self,
        cmd: &str,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        for ch in cmd.chars() {
            if self.pending_action != PendingAction::None {
                out.extend(self.handle_pending_action(ch, text, te_state));
                continue;
            }

            if ch.is_ascii_digit() {
                if ch == '0' && self.pending_count == 0 {
                    out.extend(self.apply_motion("0", text, te_state));
                    continue;
                }
                let val = ch.to_digit(10).unwrap() as usize;
                self.pending_count = self.pending_count * 10 + val;
                continue;
            }
            match ch {
                'v' => {
                    if self.visual_line {
                        self.visual_line = false;
                        let idx = Self::get_visual_cursor_char_idx(te_state);
                        let len = text.chars().count();
                        if idx < len {
                            Self::set_selection(te_state, idx, idx + 1);
                        } else {
                            Self::set_cursor_char_idx(te_state, idx);
                        }
                    } else {
                        self.exit_visual_mode(te_state, true);
                    }
                }
                'V' => {
                    self.enter_visual_line_mode(text, te_state);
                }
                'i' => {
                    self.pending_action = PendingAction::TextObjectInner;
                }
                'a' => {
                    self.pending_action = PendingAction::TextObjectA;
                }
                'd' | 'x' => {
                    out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                    self.mode = VimMode::Normal;
                    self.visual_line = false;
                }
                'c' | 's' => {
                    out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                    self.mode = VimMode::Insert;
                    self.visual_line = false;
                }
                'y' => {
                    if let Some(content) = Self::selected_text(text, te_state) {
                        self.store_yank_text(content);
                    }
                    self.yank_is_linewise = self.visual_line;
                    out.push(Event::Copy);
                    self.pending_visual_exit = true;
                }
                'p' => {
                    let reg = self.active_register();
                    let content = self.register_contents(reg);
                    out.push(Event::Paste(content));
                    self.pending_visual_exit = true;
                }
                'f' => {
                    self.pending_action = PendingAction::FindForward;
                }
                'F' => {
                    self.pending_action = PendingAction::FindBackward;
                }
                't' => {
                    self.pending_action = PendingAction::TillForward;
                }
                'T' => {
                    self.pending_action = PendingAction::TillBackward;
                }
                'W' | 'B' | 'E' => {
                    out.extend(self.move_word_motion(ch, text, te_state));
                }
                'h' | 'j' | 'k' | 'l' | 'w' | 'b' | 'e' | '0' | '$' => {
                    if matches!(ch, 'w' | 'b' | 'e') {
                        out.extend(self.move_word_motion(ch, text, te_state));
                    } else {
                        out.extend(self.apply_motion(&ch.to_string(), text, te_state));
                    }
                }
                'G' => {
                    out.extend(self.apply_g(text, te_state));
                }
                'g' => {
                    self.pending_action = PendingAction::WaitG;
                }
                _ => {}
            }
        }
        out
    }

    fn handle_pending_action(
        &mut self,
        ch: char,
        text: &mut String,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        let action = self.pending_action;
        self.pending_action = PendingAction::None;
        let c_idx = Self::get_cursor_char_idx(te_state);

        match action {
            PendingAction::Register => {
                self.pending_register = Some(ch);
            }
            PendingAction::MacroRecord => {
                self.recording_macro = Some(ch);
                self.macros.insert(ch, Vec::new());
            }
            PendingAction::MacroPlayback => {
                if let Some(events) = self.macros.get(&ch).cloned() {
                    for event in events {
                        out.extend(self.handle_event_impl(&event, text, te_state, false));
                        self.flush_pending_visual_exit(te_state);
                    }
                }
            }
            PendingAction::Mark => {
                self.marks.insert(ch, c_idx);
            }
            PendingAction::Jump => {
                if let Some(&idx) = self.marks.get(&ch) {
                    Self::set_cursor_char_idx(te_state, idx);
                }
            }
            PendingAction::FindForward | PendingAction::TillForward => {
                let count = self.consume_count();
                let mut target = c_idx;
                let mut found = 0;
                let mut search_start = c_idx + 1;
                if action == PendingAction::TillForward
                    && text.chars().nth(search_start) == Some(ch)
                {
                    search_start += 1;
                }
                for (i, c) in text.chars().skip(search_start).enumerate() {
                    if c == ch {
                        found += 1;
                        if found == count {
                            target = search_start + i;
                            break;
                        }
                    }
                }
                if found == count {
                    if self.pending_operator.is_some() {
                        if matches!(action, PendingAction::FindForward) {
                            target = target.saturating_add(1);
                        }
                    } else if action == PendingAction::TillForward && target > c_idx {
                        target -= 1;
                    }
                    self.set_motion_target(te_state, target);
                    let shift = if self.mode == VimMode::Visual || self.pending_operator.is_some() {
                        Modifiers::SHIFT
                    } else {
                        Modifiers::NONE
                    };
                    for _ in 0..(target - c_idx) {
                        out.push(Self::key_event(Key::ArrowRight, shift));
                    }
                    if let Some(op) = self.pending_operator {
                        out.extend(self.apply_operator(op, text, te_state));
                    }
                }
                self.last_find = Some((action, ch));
            }
            PendingAction::FindBackward | PendingAction::TillBackward => {
                let count = self.consume_count();
                let mut target = c_idx;
                let mut found = 0;
                let text_before: Vec<char> = text.chars().take(c_idx).collect();
                for (i, &c) in text_before.iter().enumerate().rev() {
                    if c == ch {
                        found += 1;
                        if found == count {
                            target = i;
                            break;
                        }
                    }
                }
                if found == count {
                    if action == PendingAction::TillBackward && target < c_idx {
                        target += 1;
                    }
                    self.set_motion_target(te_state, target);
                    let shift = if self.mode == VimMode::Visual || self.pending_operator.is_some() {
                        Modifiers::SHIFT
                    } else {
                        Modifiers::NONE
                    };
                    for _ in 0..(c_idx - target) {
                        out.push(Self::key_event(Key::ArrowLeft, shift));
                    }
                    if let Some(op) = self.pending_operator {
                        out.extend(self.apply_operator(op, text, te_state));
                    }
                }
                self.last_find = Some((action, ch));
            }
            PendingAction::TextObjectInner | PendingAction::TextObjectA => {
                let is_inner = action == PendingAction::TextObjectInner;
                if let Some((start, end)) = self.compute_text_object(ch, text, c_idx, is_inner) {
                    Self::set_selection(te_state, start, end);
                    if let Some(op) = self.pending_operator {
                        out.extend(self.apply_operator(op, text, te_state));
                    }
                } else {
                    self.pending_operator = None;
                }
            }
            PendingAction::WaitG => {
                if ch == 'g' {
                    out.extend(self.apply_gg(text, te_state));
                } else if ch == 'e' || ch == 'E' {
                    let chars: Vec<char> = text.chars().collect();
                    let target = Self::prev_word_end(&chars, c_idx, ch == 'E');
                    self.set_motion_target(te_state, target);
                    if let Some(op) = self.pending_operator {
                        out.extend(self.apply_operator(op, text, te_state));
                    }
                } else {
                    self.pending_operator = None;
                }
            }
            _ => {}
        }
        out
    }

    fn compute_text_object(
        &self,
        ch: char,
        text: &str,
        c_idx: usize,
        inner: bool,
    ) -> Option<(usize, usize)> {
        let chars: Vec<char> = text.chars().collect();
        match ch {
            'w' => {
                let mut start = c_idx;
                let mut end = c_idx;
                if start >= chars.len() {
                    return None;
                }
                let is_word_char = |c: char| c.is_alphanumeric() || c == '_';
                let is_alnum = is_word_char(chars[start]);

                while start > 0
                    && is_word_char(chars[start - 1]) == is_alnum
                    && !chars[start - 1].is_whitespace()
                {
                    start -= 1;
                }
                while end < chars.len()
                    && is_word_char(chars[end]) == is_alnum
                    && !chars[end].is_whitespace()
                {
                    end += 1;
                }
                if !inner {
                    while end < chars.len() && chars[end].is_whitespace() {
                        end += 1;
                    }
                }
                Some((start, end))
            }
            'W' => {
                let mut start = c_idx;
                let mut end = c_idx;
                if start >= chars.len() {
                    return None;
                }
                let is_word_char = |c: char| !c.is_whitespace();
                let is_word = is_word_char(chars[start]);

                while start > 0
                    && is_word_char(chars[start - 1]) == is_word
                    && !chars[start - 1].is_whitespace()
                {
                    start -= 1;
                }
                while end < chars.len()
                    && is_word_char(chars[end]) == is_word
                    && !chars[end].is_whitespace()
                {
                    end += 1;
                }
                if !inner {
                    while end < chars.len() && chars[end].is_whitespace() {
                        end += 1;
                    }
                }
                Some((start, end))
            }
            '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' => {
                let pair = match ch {
                    '(' | ')' | 'b' => ('(', ')'),
                    '[' | ']' => ('[', ']'),
                    '{' | '}' | 'B' => ('{', '}'),
                    _ => (ch, ch),
                };
                let mut start = c_idx;
                while start > 0 {
                    start -= 1;
                    if chars[start] == pair.0 {
                        break;
                    }
                }
                let mut end = c_idx;
                while end < chars.len() {
                    if chars[end] == pair.1 && end != start {
                        break;
                    }
                    end += 1;
                }
                if start < end
                    && end < chars.len()
                    && chars[start] == pair.0
                    && chars[end] == pair.1
                {
                    if inner {
                        Some((start + 1, end))
                    } else {
                        Some((start, end + 1))
                    }
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn apply_motion(
        &mut self,
        motion: &str,
        text: &str,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        if let Some(out) = self.apply_visual_motion(motion, text, te_state) {
            return out;
        }
        let mut out = Vec::new();
        let count = self.consume_count();
        let shift = if self.mode == VimMode::Visual || self.pending_operator.is_some() {
            Modifiers::SHIFT
        } else {
            Modifiers::NONE
        };

        let (key, modifiers) = match motion {
            "h" => (Key::ArrowLeft, Modifiers::NONE),
            "j" => (Key::ArrowDown, Modifiers::NONE),
            "k" => (Key::ArrowUp, Modifiers::NONE),
            "l" => (Key::ArrowRight, Modifiers::NONE),
            "w" | "e" => (Key::ArrowRight, Modifiers::ALT),
            "b" => (Key::ArrowLeft, Modifiers::ALT),
            "0" => (Key::Home, Modifiers::NONE),
            "$" => (Key::End, Modifiers::NONE),
            _ => (Key::ArrowRight, Modifiers::NONE),
        };

        if motion == "gg" || motion == "G" {
            out.push(Self::key_event(key, modifiers | shift));
        } else {
            for _ in 0..count {
                out.push(Self::key_event(key, modifiers | shift));
            }
        }

        if let Some(op) = self.pending_operator {
            out.extend(self.apply_operator(op, text, te_state));
        }
        out
    }

    fn apply_g(
        &mut self,
        text: &str,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        let explicit_count = self.pending_count;
        self.pending_count = 0;

        let shift = self.mode == VimMode::Visual || self.pending_operator.is_some();
        let anchor = Self::get_cursor_anchor(te_state);

        let target_idx = if explicit_count > 0 {
            let mut newlines = 0;
            let mut idx = 0;
            for (i, c) in text.chars().enumerate() {
                if newlines == explicit_count - 1 {
                    break;
                }
                if c == '\n' {
                    newlines += 1;
                }
                idx = i + 1;
            }
            idx
        } else {
            text.chars().count()
        };

        if shift {
            Self::set_selection(te_state, anchor, target_idx);
        } else {
            Self::set_cursor_char_idx(te_state, target_idx);
        }
        if let Some(op) = self.pending_operator {
            out.extend(self.apply_operator(op, text, te_state));
        }
        out
    }

    fn apply_gg(
        &mut self,
        text: &str,
        te_state: &mut egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        let explicit_count = self.pending_count;
        self.pending_count = 0;

        let shift = self.mode == VimMode::Visual || self.pending_operator.is_some();
        let anchor = Self::get_cursor_anchor(te_state);

        let target_idx = if explicit_count > 0 {
            let mut newlines = 0;
            let mut idx = 0;
            for (i, c) in text.chars().enumerate() {
                if newlines == explicit_count - 1 {
                    break;
                }
                if c == '\n' {
                    newlines += 1;
                }
                idx = i + 1;
            }
            idx
        } else {
            0
        };

        if shift {
            Self::set_selection(te_state, anchor, target_idx);
        } else {
            Self::set_cursor_char_idx(te_state, target_idx);
        }
        if let Some(op) = self.pending_operator {
            out.extend(self.apply_operator(op, text, te_state));
        }
        out
    }

    fn apply_operator(
        &mut self,
        op: Operator,
        text: &str,
        te_state: &egui::widgets::text_edit::TextEditState,
    ) -> Vec<Event> {
        let mut out = Vec::new();
        match op {
            Operator::Delete => {
                out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
            }
            Operator::Change => {
                out.push(Self::key_event(Key::Backspace, Modifiers::NONE));
                self.mode = VimMode::Insert;
            }
            Operator::Yank => {
                if let Some(content) = Self::selected_text(text, te_state) {
                    self.store_yank_text(content);
                }
                self.yank_is_linewise = false;
                out.push(Event::Copy);
                out.push(Self::key_event(Key::ArrowLeft, Modifiers::NONE));
            } // we rely on egui copy logic; for complete internal yank we'd need text lookup
        }
        self.pending_operator = None;
        self.note_last_change_output(&out);
        self.finish_last_change_recording_if_ready();
        out
    }

    fn delete_line(&self) -> Vec<Event> {
        vec![
            Self::key_event(Key::Home, Modifiers::NONE),
            Self::key_event(Key::End, Modifiers::SHIFT),
            Self::key_event(Key::ArrowRight, Modifiers::SHIFT),
            Self::key_event(Key::Backspace, Modifiers::NONE),
        ]
    }

    fn change_line(&self) -> Vec<Event> {
        vec![
            Self::key_event(Key::Home, Modifiers::NONE),
            Self::key_event(Key::End, Modifiers::SHIFT),
            Self::key_event(Key::Backspace, Modifiers::NONE),
        ]
    }

    fn yank_line(&self) -> Vec<Event> {
        vec![
            Self::key_event(Key::Home, Modifiers::NONE),
            Self::key_event(Key::End, Modifiers::SHIFT),
            Event::Copy,
            Self::key_event(Key::ArrowLeft, Modifiers::NONE),
        ]
    }

    fn key_event(key: Key, modifiers: Modifiers) -> Event {
        Event::Key {
            key,
            pressed: true,
            repeat: false,
            modifiers,
            physical_key: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::widgets::text_edit::TextEditState;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn key_press(key: Key) -> Event {
        Event::Key {
            key,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
            physical_key: None,
        }
    }

    fn key_press_with_modifiers(key: Key, modifiers: Modifiers) -> Event {
        Event::Key {
            key,
            pressed: true,
            repeat: false,
            modifiers,
            physical_key: None,
        }
    }

    fn escape(vim: &mut VimState, text: &mut String, te: &mut TextEditState) {
        vim.handle_event(&key_press(Key::Escape), text, te);
    }

    fn ctrl_bracket(vim: &mut VimState, text: &mut String, te: &mut TextEditState) {
        vim.handle_event(
            &key_press_with_modifiers(Key::OpenBracket, Modifiers::CTRL),
            text,
            te,
        );
    }

    fn press_enter(vim: &mut VimState, text: &mut String, te: &mut TextEditState) {
        vim.handle_event(&key_press(Key::Enter), text, te);
    }

    fn send(vim: &mut VimState, text: &mut String, te: &mut TextEditState, s: &str) -> Vec<Event> {
        let mut out = vec![];
        for ch in s.chars() {
            out.extend(vim.handle_event(&Event::Text(ch.to_string()), text, te));
        }
        out
    }

    fn set_cursor(te: &mut TextEditState, idx: usize) {
        VimState::set_cursor_char_idx(te, idx);
    }

    fn cursor(te: &TextEditState) -> usize {
        VimState::get_cursor_char_idx(te)
    }

    fn selection(te: &TextEditState) -> Option<(usize, usize)> {
        te.cursor.char_range().map(|r| {
            let [start, end] = r.sorted();
            (start.index, end.index)
        })
    }

    // -----------------------------------------------------------------------
    // Text object tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_text_object_compute() {
        let vim = VimState::new();
        let text = "hello (world) test";
        let start = vim.compute_text_object('(', text, 8, true).unwrap();
        assert_eq!(start, (7, 12));
    }

    #[test]
    fn test_word_text_object() {
        let vim = VimState::new();
        let text = "let foo_bar = 5;";
        let bounds = vim.compute_text_object('w', text, 5, true).unwrap();
        assert_eq!(bounds, (4, 11));
    }

    #[test]
    fn test_text_object_a_word_includes_trailing_space() {
        let vim = VimState::new();
        let text = "foo bar baz";
        // 'aw' at position 0 should include trailing whitespace
        let bounds = vim.compute_text_object('w', text, 0, false).unwrap();
        assert_eq!(bounds, (0, 4)); // "foo "
    }

    #[test]
    fn test_text_object_inner_parens() {
        let vim = VimState::new();
        let text = "(hello world)";
        let bounds = vim.compute_text_object('(', text, 5, true).unwrap();
        assert_eq!(bounds, (1, 12)); // "hello world"
    }

    #[test]
    fn test_text_object_a_parens_includes_delimiters() {
        let vim = VimState::new();
        let text = "(hello)";
        let bounds = vim.compute_text_object('(', text, 3, false).unwrap();
        assert_eq!(bounds, (0, 7));
    }

    #[test]
    fn test_text_object_inner_double_quotes() {
        let vim = VimState::new();
        let text = r#""hello world""#;
        let bounds = vim.compute_text_object('"', text, 5, true).unwrap();
        assert_eq!(bounds, (1, 12));
    }

    #[test]
    fn test_text_object_square_brackets() {
        let vim = VimState::new();
        let text = "[item]";
        let bounds = vim.compute_text_object('[', text, 2, true).unwrap();
        assert_eq!(bounds, (1, 5));
    }

    #[test]
    fn test_text_object_no_match_returns_none() {
        let vim = VimState::new();
        let text = "no parens here";
        let result = vim.compute_text_object('(', text, 3, true);
        assert!(result.is_none());
    }

    // -----------------------------------------------------------------------
    // Mode transition tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_default_mode_is_normal() {
        let vim = VimState::new();
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_i_enters_insert_mode() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "i");
        assert_eq!(vim.mode, VimMode::Insert);
    }

    #[test]
    fn test_escape_returns_to_normal_from_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "i");
        assert_eq!(vim.mode, VimMode::Insert);
        escape(&mut vim, &mut text, &mut te);
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_a_enters_insert_after_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "a");
        assert_eq!(vim.mode, VimMode::Insert);
        // 'a' should emit an ArrowRight before switching to insert
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowRight,
                ..
            }
        )));
    }

    #[test]
    fn test_a_uppercase_enters_insert_at_end_of_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "A");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Key { key: Key::End, .. })));
    }

    #[test]
    fn test_big_w_moves_to_next_non_whitespace_run() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo, bar baz".to_string();
        set_cursor(&mut te, 0);

        let _ = send(&mut vim, &mut text, &mut te, "W");
        assert_eq!(cursor(&te), 5);
    }

    #[test]
    fn test_big_b_moves_to_previous_non_whitespace_run() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo, bar baz".to_string();
        set_cursor(&mut te, 9);

        let _ = send(&mut vim, &mut text, &mut te, "B");
        assert_eq!(cursor(&te), 5);
    }

    #[test]
    fn test_ctrl_r_maps_to_redo() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();

        let ev = Event::Key {
            key: Key::R,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        };
        let out = vim.handle_event(&ev, &mut text, &mut te);

        assert!(out.iter().any(|event| matches!(
            event,
            Event::Key { key: Key::Z, modifiers, .. } if modifiers.mac_cmd && modifiers.shift
        )));
    }

    #[test]
    fn test_i_uppercase_enters_insert_at_start_of_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "I");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Key { key: Key::Home, .. })));
    }

    #[test]
    fn test_o_opens_line_below_and_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "o");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Key { key: Key::End, .. })));
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Enter,
                ..
            }
        )));
    }

    #[test]
    fn test_o_uppercase_opens_line_above_and_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "O");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Key { key: Key::Home, .. })));
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Enter,
                ..
            }
        )));
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowUp,
                ..
            }
        )));
    }

    #[test]
    fn test_v_enters_visual_mode() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "v");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((0, 1)));
    }

    #[test]
    fn test_v_selects_current_character_at_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 2);

        send(&mut vim, &mut text, &mut te, "v");

        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((2, 3)));
        assert_eq!(cursor(&te), 3);
    }

    #[test]
    fn test_visual_h_extends_selection_left() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 2);

        send(&mut vim, &mut text, &mut te, "v");
        send(&mut vim, &mut text, &mut te, "h");

        assert_eq!(selection(&te), Some((1, 3)));
    }

    #[test]
    fn test_visual_l_extends_selection_right() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 2);

        send(&mut vim, &mut text, &mut te, "v");
        send(&mut vim, &mut text, &mut te, "l");

        assert_eq!(selection(&te), Some((2, 4)));
    }

    #[test]
    fn test_visual_v_toggles_back_to_normal_and_keeps_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 2);

        send(&mut vim, &mut text, &mut te, "v");
        send(&mut vim, &mut text, &mut te, "l");
        send(&mut vim, &mut text, &mut te, "v");

        assert_eq!(vim.mode, VimMode::Normal);
        assert_eq!(cursor(&te), 3);
        assert_eq!(selection(&te), Some((3, 3)));
    }

    #[test]
    fn test_escape_returns_to_normal_from_visual() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 2);
        send(&mut vim, &mut text, &mut te, "v");
        send(&mut vim, &mut text, &mut te, "h");
        escape(&mut vim, &mut text, &mut te);
        assert_eq!(vim.mode, VimMode::Normal);
        assert_eq!(cursor(&te), 1);
        assert_eq!(selection(&te), Some((1, 1)));
    }

    #[test]
    fn test_colon_enters_command_mode() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        assert_eq!(vim.mode, VimMode::CommandLine);
        assert_eq!(vim.command_prefix, ':');
    }

    #[test]
    fn test_slash_enters_command_mode_for_search() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "/");
        assert_eq!(vim.mode, VimMode::CommandLine);
        assert_eq!(vim.command_prefix, '/');
    }

    #[test]
    fn test_question_mark_enters_reverse_search() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "?");
        assert_eq!(vim.mode, VimMode::CommandLine);
        assert_eq!(vim.command_prefix, '?');
    }

    #[test]
    fn test_escape_from_command_mode_clears_buffer() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        send(&mut vim, &mut text, &mut te, "wq");
        assert_eq!(vim.command_buffer, "wq");
        escape(&mut vim, &mut text, &mut te);
        assert_eq!(vim.mode, VimMode::Normal);
        assert_eq!(vim.command_buffer, "");
    }

    // -----------------------------------------------------------------------
    // Motion tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_h_emits_arrow_left() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "h");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowLeft,
                ..
            }
        )));
    }

    #[test]
    fn test_l_emits_arrow_right() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "l");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowRight,
                ..
            }
        )));
    }

    #[test]
    fn test_j_emits_arrow_down() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "j");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowDown,
                ..
            }
        )));
    }

    #[test]
    fn test_k_emits_arrow_up() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "k");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowUp,
                ..
            }
        )));
    }

    #[test]
    fn test_w_moves_to_next_word_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "w");
        assert_eq!(cursor(&te), 6);
    }

    #[test]
    fn test_b_moves_to_previous_word_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        set_cursor(&mut te, 6);
        let _ = send(&mut vim, &mut text, &mut te, "b");
        assert_eq!(cursor(&te), 0);
    }

    #[test]
    fn test_dollar_emits_end_of_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "$");
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Key { key: Key::End, .. })));
    }

    #[test]
    fn test_zero_emits_home() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "0");
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Key { key: Key::Home, .. })));
    }

    #[test]
    fn test_count_multiplies_motion() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "3l");
        let right_count = evs.iter().filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if modifiers == &Modifiers::NONE)).count();
        assert_eq!(right_count, 3);
    }

    #[test]
    fn test_count_accumulates_digits() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        // Type '1' then '2' then 'l' → 12 right arrows
        let evs = send(&mut vim, &mut text, &mut te, "12l");
        let right_count = evs.iter().filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if modifiers == &Modifiers::NONE)).count();
        assert_eq!(right_count, 12);
    }

    #[test]
    fn test_g_uppercase_moves_to_end() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let text = "line1\nline2\nline3".to_string();
        set_cursor(&mut te, 0);
        vim.apply_g(&text, &mut te);
        assert_eq!(cursor(&te), text.chars().count());
    }

    #[test]
    fn test_gg_moves_to_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let text = "line1\nline2\nline3".to_string();
        set_cursor(&mut te, 10);
        vim.apply_gg(&text, &mut te);
        assert_eq!(cursor(&te), 0);
    }

    #[test]
    fn test_g_then_g_triggers_gg() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "line1\nline2".to_string();
        set_cursor(&mut te, 8);
        send(&mut vim, &mut text, &mut te, "gg");
        assert_eq!(cursor(&te), 0);
    }

    // -----------------------------------------------------------------------
    // Delete / change / yank tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_x_deletes_char_under_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "x");
        // x does shift-right then backspace
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_x_with_count() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "3x");
        let shift_rights = evs.iter().filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if modifiers.shift)).count();
        assert_eq!(shift_rights, 3);
    }

    #[test]
    fn test_dd_deletes_current_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello\nworld".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "dd");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_d_pending_operator_set() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "d");
        assert_eq!(vim.pending_operator, Some(Operator::Delete));
    }

    #[test]
    fn test_cc_changes_current_line_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        send(&mut vim, &mut text, &mut te, "cc");
        assert_eq!(vim.mode, VimMode::Insert);
    }

    #[test]
    fn test_yy_yanks_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "yy");
        assert!(evs.iter().any(|e| matches!(e, Event::Copy)));
        assert_eq!(vim.yank_buffer, "hello");
        assert!(vim.yank_is_linewise);
    }

    #[test]
    fn test_p_pastes_yank_buffer() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        vim.yank_buffer = "world".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "p");
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Paste(s) if s == "world")));
    }

    #[test]
    fn test_yy_then_p_uses_linewise_newline_semantics() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello\nworld".to_string();
        set_cursor(&mut te, 0);

        send(&mut vim, &mut text, &mut te, "yy");
        let evs = send(&mut vim, &mut text, &mut te, "p");

        assert!(evs.iter().any(|e| matches!(e, Event::Key { key: Key::End, .. })));
        assert!(evs.iter().any(|e| matches!(e, Event::Key { key: Key::Enter, .. })));
        assert!(evs.iter().any(|e| matches!(e, Event::Paste(s) if s == "hello")));
    }

    #[test]
    fn test_dot_repeats_last_change() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();

        let first = send(&mut vim, &mut text, &mut te, "x");
        let repeated = send(&mut vim, &mut text, &mut te, ".");

        assert!(first.iter().any(|e| matches!(e, Event::Key { key: Key::Backspace, .. })));
        assert!(repeated.iter().any(|e| matches!(e, Event::Key { key: Key::Backspace, .. })));
    }

    #[test]
    fn test_r_replace_char() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "r");
        assert!(vim.pending_replace);
        let evs = send(&mut vim, &mut text, &mut te, "x");
        // pending_replace should be consumed
        assert!(!vim.pending_replace);
        assert!(evs.iter().any(|e| matches!(e, Event::Text(t) if t == "x")));
    }

    #[test]
    fn test_u_emits_undo() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "u");
        // u → Cmd+Z
        assert!(evs.iter().any(|e| matches!(e, Event::Key { key: Key::Z, modifiers, .. } if modifiers.command || modifiers.mac_cmd)));
    }

    #[test]
    fn test_tilde_toggles_case() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "~");
        // Should emit delete + uppercase char
        assert!(evs.iter().any(|e| matches!(e, Event::Text(t) if t == "H")));
    }

    #[test]
    fn test_tilde_lowercase_to_uppercase() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc".to_string();
        set_cursor(&mut te, 2); // 'c'
        let evs = send(&mut vim, &mut text, &mut te, "~");
        assert!(evs.iter().any(|e| matches!(e, Event::Text(t) if t == "C")));
    }

    #[test]
    fn test_tilde_uppercase_to_lowercase() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "HELLO".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "~");
        assert!(evs.iter().any(|e| matches!(e, Event::Text(t) if t == "h")));
    }

    // -----------------------------------------------------------------------
    // Find-char tests (f, F, t, T, ;, ,)
    // -----------------------------------------------------------------------

    #[test]
    fn test_f_motion_parsing() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();

        let _ = vim.handle_event(&Event::Text("f".into()), &mut text, &mut te);
        assert_eq!(vim.pending_action, PendingAction::FindForward);

        let evs = vim.handle_event(&Event::Text("l".into()), &mut text, &mut te);
        assert_eq!(evs.len(), 2);
    }

    #[test]
    fn test_f_sets_last_find() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "fl");
        assert!(matches!(
            vim.last_find,
            Some((PendingAction::FindForward, 'l'))
        ));
    }

    #[test]
    fn test_f_uppercase_finds_backward() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "F");
        assert_eq!(vim.pending_action, PendingAction::FindBackward);
    }

    #[test]
    fn test_t_till_forward_pending() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        send(&mut vim, &mut text, &mut te, "t");
        assert_eq!(vim.pending_action, PendingAction::TillForward);
    }

    #[test]
    fn test_t_uppercase_till_backward_pending() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        send(&mut vim, &mut text, &mut te, "T");
        assert_eq!(vim.pending_action, PendingAction::TillBackward);
    }

    #[test]
    fn test_semicolon_repeats_last_find() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 0);
        // Find 'l' forward (first 'l' is at index 2): emits 2 ArrowRights
        let evs = send(&mut vim, &mut text, &mut te, "fl");
        let rights = evs.iter().filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if modifiers == &Modifiers::NONE)).count();
        assert_eq!(rights, 2);
        assert!(matches!(
            vim.last_find,
            Some((PendingAction::FindForward, 'l'))
        ));

        // Manually advance cursor to simulate the editor applying those events
        set_cursor(&mut te, 2);

        // ';' repeats: from position 2, next 'l' is at index 3 → 1 ArrowRight
        let evs2 = send(&mut vim, &mut text, &mut te, ";");
        let rights2 = evs2.iter().filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if modifiers == &Modifiers::NONE)).count();
        assert_eq!(rights2, 1);
    }

    #[test]
    fn test_comma_reverses_last_find() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 0);
        // 'fl' → last_find = (FindForward, 'l'), cursor manually set to 3
        send(&mut vim, &mut text, &mut te, "fl");
        set_cursor(&mut te, 3); // simulate: cursor is at second 'l'

        // ',' reverses direction: from index 3, search backward for 'l' → index 2 (1 step left)
        let evs = send(&mut vim, &mut text, &mut te, ",");
        let lefts = evs.iter().filter(|e| matches!(e, Event::Key { key: Key::ArrowLeft, modifiers, .. } if modifiers == &Modifiers::NONE)).count();
        assert_eq!(lefts, 1);
    }

    // -----------------------------------------------------------------------
    // Visual mode tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_visual_d_deletes_selection() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "v");
        send(&mut vim, &mut text, &mut te, "d");
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_visual_c_changes_selection_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "v");
        send(&mut vim, &mut text, &mut te, "c");
        assert_eq!(vim.mode, VimMode::Insert);
    }

    #[test]
    fn test_visual_y_yanks_and_returns_normal() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "v");
        let evs = send(&mut vim, &mut text, &mut te, "y");
        assert_eq!(vim.mode, VimMode::Visual);
        assert!(vim.pending_visual_exit);
        assert!(evs.iter().any(|e| matches!(e, Event::Copy)));

        vim.flush_pending_visual_exit(&mut te);
        assert_eq!(vim.mode, VimMode::Normal);
        assert!(!vim.pending_visual_exit);
    }

    #[test]
    fn test_visual_y_writes_internal_yank_buffer_and_named_register() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 2);

        send(&mut vim, &mut text, &mut te, "\"aviw");
        let evs = send(&mut vim, &mut text, &mut te, "y");

        assert!(evs.iter().any(|e| matches!(e, Event::Copy)));
        assert!(vim.pending_visual_exit);
        vim.flush_pending_visual_exit(&mut te);

        assert_eq!(vim.mode, VimMode::Normal);
        assert_eq!(vim.yank_buffer, "alpha");
        assert_eq!(vim.registers.get(&'a').map(String::as_str), Some("alpha"));
    }

    #[test]
    fn test_visual_p_replaces_selection_with_yank_buffer() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        vim.yank_buffer = "omega".to_string();
        set_cursor(&mut te, 2);
        send(&mut vim, &mut text, &mut te, "viw");

        assert_eq!(vim.mode, VimMode::Visual);
        let evs = send(&mut vim, &mut text, &mut te, "p");

        assert!(
            evs.iter()
                .any(|e| matches!(e, Event::Paste(s) if s == "omega")),
            "visual p should emit a paste of the yank buffer"
        );
        assert!(
            vim.pending_visual_exit,
            "visual p should defer exit until the editor flushes the selection"
        );
        vim.flush_pending_visual_exit(&mut te);
        assert_eq!(vim.mode, VimMode::Normal);
        assert!(!vim.pending_visual_exit);
    }

    #[test]
    fn test_visual_x_deletes_and_returns_normal() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "v");
        let evs = send(&mut vim, &mut text, &mut te, "x");
        assert_eq!(vim.mode, VimMode::Normal);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_visual_s_changes_selection_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "v");
        let evs = send(&mut vim, &mut text, &mut te, "s");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_visual_motion_updates_selection() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "v");
        send(&mut vim, &mut text, &mut te, "l");
        assert_eq!(selection(&te), Some((0, 2)));
    }

    #[test]
    fn test_v_uppercase_enters_visual_line_mode() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha\nbeta".to_string();
        set_cursor(&mut te, 2);

        send(&mut vim, &mut text, &mut te, "V");

        assert_eq!(vim.mode, VimMode::Visual);
        assert!(vim.visual_line);
        assert_eq!(selection(&te), Some((0, 6)));
    }

    #[test]
    fn test_visual_line_j_extends_selection_to_next_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha\nbeta\ngamma".to_string();
        send(&mut vim, &mut text, &mut te, "V");

        send(&mut vim, &mut text, &mut te, "j");

        assert!(vim.visual_line);
        assert_eq!(selection(&te), Some((0, 11)));
    }

    #[test]
    fn test_visual_line_s_changes_selected_lines_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha\nbeta".to_string();
        send(&mut vim, &mut text, &mut te, "V");

        let evs = send(&mut vim, &mut text, &mut te, "s");

        assert_eq!(vim.mode, VimMode::Insert);
        assert!(!vim.visual_line);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    // -----------------------------------------------------------------------
    // Command line / search tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_colon_w_sets_save_requested() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        send(&mut vim, &mut text, &mut te, "w");
        vim.handle_event(&key_press(Key::Enter), &mut text, &mut te);
        assert!(vim.save_requested);
    }

    #[test]
    fn test_colon_wq_sets_save_requested() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        send(&mut vim, &mut text, &mut te, "wq");
        vim.handle_event(&key_press(Key::Enter), &mut text, &mut te);
        assert!(vim.save_requested);
    }

    #[test]
    fn test_colon_x_sets_save_requested() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        send(&mut vim, &mut text, &mut te, "x");
        vim.handle_event(&key_press(Key::Enter), &mut text, &mut te);
        assert!(vim.save_requested);
    }

    #[test]
    fn test_command_backspace_cancels_w_before_enter() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        send(&mut vim, &mut text, &mut te, "w");
        vim.handle_event(&key_press(Key::Backspace), &mut text, &mut te);
        vim.handle_event(&key_press(Key::Enter), &mut text, &mut te);
        assert!(!vim.save_requested);
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_command_buffer_accumulates_text() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        send(&mut vim, &mut text, &mut te, "wq");
        assert_eq!(vim.command_buffer, "wq");
    }

    #[test]
    fn test_command_backspace_removes_last_char() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        send(&mut vim, &mut text, &mut te, "wq");
        vim.handle_event(&key_press(Key::Backspace), &mut text, &mut te);
        assert_eq!(vim.command_buffer, "w");
    }

    #[test]
    fn test_command_backspace_on_empty_exits_command_mode() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":");
        vim.handle_event(&key_press(Key::Backspace), &mut text, &mut te);
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_search_forward_sets_last_search() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world hello".to_string();
        send(&mut vim, &mut text, &mut te, "/");
        send(&mut vim, &mut text, &mut te, "hello");
        vim.handle_event(&key_press(Key::Enter), &mut text, &mut te);
        assert_eq!(vim.last_search, "hello");
    }

    #[test]
    fn test_search_forward_moves_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo bar foo".to_string();
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "/");
        send(&mut vim, &mut text, &mut te, "bar");
        vim.handle_event(&key_press(Key::Enter), &mut text, &mut te);
        assert_eq!(cursor(&te), 4); // "bar" starts at index 4
    }

    #[test]
    fn test_empty_search_prompt_does_not_clear_last_search() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo bar foo".to_string();
        vim.last_search = "bar".to_string();

        send(&mut vim, &mut text, &mut te, "/");
        send(&mut vim, &mut text, &mut te, "bar");
        vim.handle_event(&key_press(Key::Backspace), &mut text, &mut te);
        vim.handle_event(&key_press(Key::Backspace), &mut text, &mut te);
        vim.handle_event(&key_press(Key::Backspace), &mut text, &mut te);
        vim.handle_event(&key_press(Key::Enter), &mut text, &mut te);

        assert_eq!(vim.last_search, "bar");
        send(&mut vim, &mut text, &mut te, "n");
        assert_eq!(cursor(&te), 4);
    }

    #[test]
    fn test_search_wraps_around() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo bar foo".to_string();
        set_cursor(&mut te, 8); // at second "foo"
        send(&mut vim, &mut text, &mut te, "/");
        send(&mut vim, &mut text, &mut te, "foo");
        vim.handle_event(&key_press(Key::Enter), &mut text, &mut te);
        // should wrap to start and find first "foo" at 0
        assert_eq!(cursor(&te), 0);
    }

    #[test]
    fn test_n_repeats_search() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "aa bb aa".to_string();
        set_cursor(&mut te, 0);
        vim.last_search = "aa".to_string();
        send(&mut vim, &mut text, &mut te, "n");
        // n with last_search="aa" from pos 0 should jump to index 6
        assert_eq!(cursor(&te), 6);
    }

    // -----------------------------------------------------------------------
    // Marks tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_m_sets_mark() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        set_cursor(&mut te, 5);
        send(&mut vim, &mut text, &mut te, "ma");
        assert_eq!(vim.marks.get(&'a'), Some(&5));
    }

    #[test]
    fn test_backtick_jumps_to_mark() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        set_cursor(&mut te, 5);
        send(&mut vim, &mut text, &mut te, "ma"); // mark at 5
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "`a"); // jump to mark
        assert_eq!(cursor(&te), 5);
    }

    #[test]
    fn test_single_quote_jumps_to_mark() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        set_cursor(&mut te, 7);
        send(&mut vim, &mut text, &mut te, "mb");
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "'b");
        assert_eq!(cursor(&te), 7);
    }

    // -----------------------------------------------------------------------
    // Register tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_double_quote_sets_pending_register() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "\"");
        assert_eq!(vim.pending_action, PendingAction::Register);
        send(&mut vim, &mut text, &mut te, "a");
        assert_eq!(vim.pending_register, Some('a'));
    }

    #[test]
    fn test_p_uses_named_register() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        vim.registers.insert('a', "stored".to_string());
        send(&mut vim, &mut text, &mut te, "\"");
        send(&mut vim, &mut text, &mut te, "a");
        let evs = send(&mut vim, &mut text, &mut te, "p");
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Paste(s) if s == "stored")));
    }

    #[test]
    fn test_empty_named_register_does_not_fall_back_to_unnamed_yank_buffer() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        vim.yank_buffer = "world".to_string();

        send(&mut vim, &mut text, &mut te, "\"");
        send(&mut vim, &mut text, &mut te, "a");
        let evs = send(&mut vim, &mut text, &mut te, "p");

        assert!(
            evs.iter()
                .any(|e| matches!(e, Event::Paste(s) if s.is_empty())),
            "an empty named register should paste empty content, not the unnamed yank buffer"
        );
    }

    // -----------------------------------------------------------------------
    // Macro tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_macro_recording() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();

        vim.handle_event(&Event::Text("q".into()), &mut text, &mut te);
        vim.handle_event(&Event::Text("a".into()), &mut text, &mut te);
        assert_eq!(vim.recording_macro, Some('a'));

        // type some things
        vim.handle_event(&Event::Text("i".into()), &mut text, &mut te);
        vim.handle_event(&Event::Text("a".into()), &mut text, &mut te);

        // stop recording
        vim.handle_event(
            &Event::Key {
                key: Key::Escape,
                pressed: true,
                repeat: false,
                modifiers: Modifiers::NONE,
                physical_key: None,
            },
            &mut text,
            &mut te,
        );
        vim.handle_event(&Event::Text("q".into()), &mut text, &mut te);
        assert_eq!(vim.recording_macro, None);
        assert!(vim.macros.contains_key(&'a'));
        assert_eq!(vim.macros[&'a'].len(), 3); // 'i', 'a', Escape
    }

    #[test]
    fn test_macro_playback_replays_events() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();

        // Record macro 'b': press 'l' (move right)
        send(&mut vim, &mut text, &mut te, "qb");
        send(&mut vim, &mut text, &mut te, "l");
        vim.handle_event(&key_press(Key::Escape), &mut text, &mut te);
        send(&mut vim, &mut text, &mut te, "q"); // stop recording

        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "@b");
        // playback should have replayed 'l' → ArrowRight
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowRight,
                ..
            }
        )));
    }

    #[test]
    fn test_recording_macro_does_not_inline_playback_body() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();

        vim.macros.insert(
            'a',
            vec![Event::Key {
                key: Key::ArrowRight,
                pressed: true,
                repeat: false,
                modifiers: Modifiers::NONE,
                physical_key: None,
            }],
        );

        send(&mut vim, &mut text, &mut te, "qb");
        send(&mut vim, &mut text, &mut te, "@a");
        send(&mut vim, &mut text, &mut te, "q");

        let recorded = vim.macros.get(&'b').cloned().unwrap_or_default();
        assert_eq!(
            recorded,
            vec![Event::Text("@".into()), Event::Text("a".into())],
            "macro recording should capture the literal @a invocation, not the expanded playback body",
        );
    }

    // -----------------------------------------------------------------------
    // Pending state / escape tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_escape_clears_pending_operator() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "d"); // set pending delete
        assert_eq!(vim.pending_operator, Some(Operator::Delete));
        escape(&mut vim, &mut text, &mut te);
        assert_eq!(vim.pending_operator, None);
    }

    #[test]
    fn test_escape_clears_pending_count() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "5");
        assert_eq!(vim.pending_count, 5);
        escape(&mut vim, &mut text, &mut te);
        assert_eq!(vim.pending_count, 0);
    }

    #[test]
    fn test_escape_clears_pending_replace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "r");
        assert!(vim.pending_replace);
        escape(&mut vim, &mut text, &mut te);
        assert!(!vim.pending_replace);
    }

    // -----------------------------------------------------------------------
    // Insert mode passthrough test
    // -----------------------------------------------------------------------

    #[test]
    fn test_insert_mode_passes_text_through() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "i"); // enter insert
        let evs = vim.handle_event(&Event::Text("x".into()), &mut text, &mut te);
        assert!(evs.iter().any(|e| matches!(e, Event::Text(t) if t == "x")));
    }

    #[test]
    fn test_insert_mode_passes_arrow_keys_through() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "i");
        let evs = vim.handle_event(&key_press(Key::ArrowRight), &mut text, &mut te);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowRight,
                ..
            }
        )));
    }

    // -----------------------------------------------------------------------
    // Ctrl shortcuts in normal mode
    // -----------------------------------------------------------------------

    #[test]
    fn test_ctrl_d_emits_page_down() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let ev = Event::Key {
            key: Key::D,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        };
        let evs = vim.handle_event(&ev, &mut text, &mut te);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::PageDown,
                ..
            }
        )));
    }

    #[test]
    fn test_ctrl_u_emits_page_up() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let ev = Event::Key {
            key: Key::U,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        };
        let evs = vim.handle_event(&ev, &mut text, &mut te);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::PageUp,
                ..
            }
        )));
    }

    #[test]
    fn test_ctrl_f_emits_page_down() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let ev = Event::Key {
            key: Key::F,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        };
        let evs = vim.handle_event(&ev, &mut text, &mut te);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::PageDown,
                ..
            }
        )));
    }

    #[test]
    fn test_ctrl_b_emits_page_up() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let ev = Event::Key {
            key: Key::B,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        };
        let evs = vim.handle_event(&ev, &mut text, &mut te);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::PageUp,
                ..
            }
        )));
    }

    // -----------------------------------------------------------------------
    // Caret motion test
    // -----------------------------------------------------------------------

    #[test]
    fn test_caret_moves_to_first_nonwhitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "   hello".to_string();
        set_cursor(&mut te, 7);
        let evs = send(&mut vim, &mut text, &mut te, "^");
        // Should emit ArrowLeft events to reach index 3
        let lefts = evs
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    Event::Key {
                        key: Key::ArrowLeft,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(lefts, 4);
    }

    #[test]
    fn test_caret_from_before_first_nonwhitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "   hello".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "^");
        let rights = evs
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    Event::Key {
                        key: Key::ArrowRight,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(rights, 3);
    }

    // -----------------------------------------------------------------------
    // Basic motion/operator matrix
    // -----------------------------------------------------------------------

    #[test]
    fn test_two_w_moves_to_second_word_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta gamma".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "2w");
        assert_eq!(cursor(&te), 11);
    }

    #[test]
    fn test_two_big_w_moves_to_second_non_whitespace_run() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo, bar baz".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "2W");
        assert_eq!(cursor(&te), 9);
    }

    #[test]
    fn test_two_b_moves_to_second_previous_word_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta gamma".to_string();
        set_cursor(&mut te, 11);
        let _ = send(&mut vim, &mut text, &mut te, "2b");
        assert_eq!(cursor(&te), 0);
    }

    #[test]
    fn test_two_big_b_moves_to_second_previous_non_whitespace_run() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo, bar baz".to_string();
        set_cursor(&mut te, 9);
        let _ = send(&mut vim, &mut text, &mut te, "2B");
        assert_eq!(cursor(&te), 0);
    }

    #[test]
    fn test_two_e_moves_to_second_word_end() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta gamma".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "2e");
        assert_eq!(cursor(&te), 9);
    }

    #[test]
    fn test_two_big_e_moves_to_second_non_whitespace_end() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo, bar baz".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "2E");
        assert_eq!(cursor(&te), 7);
    }

    #[test]
    fn test_w_from_punctuation_skips_to_next_word_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo, bar".to_string();
        set_cursor(&mut te, 3);
        let _ = send(&mut vim, &mut text, &mut te, "w");
        assert_eq!(cursor(&te), 5);
    }

    #[test]
    fn test_e_from_whitespace_moves_to_end_of_next_word() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo  bar".to_string();
        set_cursor(&mut te, 3);
        let _ = send(&mut vim, &mut text, &mut te, "e");
        assert_eq!(cursor(&te), 7);
    }

    #[test]
    fn test_e_stays_on_last_word_when_followed_only_by_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello   ".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "e");
        assert_eq!(cursor(&te), 4);
    }

    #[test]
    fn test_big_e_stays_on_last_run_when_followed_only_by_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo-bar   ".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "E");
        assert_eq!(cursor(&te), 6);
    }

    #[test]
    fn test_ge_stays_on_last_word_at_end_of_file() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello   ".to_string();
        set_cursor(&mut te, text.chars().count());
        let _ = send(&mut vim, &mut text, &mut te, "ge");
        assert_eq!(cursor(&te), 4);
    }

    #[test]
    fn test_big_ge_stays_on_last_run_at_end_of_file() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo-bar   ".to_string();
        set_cursor(&mut te, text.chars().count());
        let _ = send(&mut vim, &mut text, &mut te, "gE");
        assert_eq!(cursor(&te), 6);
    }

    #[test]
    fn test_b_from_whitespace_moves_to_previous_word_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo  bar".to_string();
        set_cursor(&mut te, 5);
        let _ = send(&mut vim, &mut text, &mut te, "b");
        assert_eq!(cursor(&te), 0);
    }

    #[test]
    fn test_c_sets_pending_change_operator() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "c");
        assert_eq!(vim.pending_operator, Some(Operator::Change));
    }

    #[test]
    fn test_y_sets_pending_yank_operator() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "y");
        assert_eq!(vim.pending_operator, Some(Operator::Yank));
    }

    #[test]
    fn test_two_dd_deletes_two_lines() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "one\ntwo\nthree".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "2dd");
        let backspaces = evs
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    Event::Key {
                        key: Key::Backspace,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(backspaces, 2);
    }

    #[test]
    fn test_three_yy_yanks_three_lines() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "one\ntwo\nthree".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "3yy");
        let copies = evs.iter().filter(|e| matches!(e, Event::Copy)).count();
        assert_eq!(copies, 3);
    }

    #[test]
    fn test_two_cc_changes_two_lines_and_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "one\ntwo\nthree".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "2cc");
        let backspaces = evs
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    Event::Key {
                        key: Key::Backspace,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(backspaces, 2);
        assert_eq!(vim.mode, VimMode::Insert);
    }

    #[test]
    fn test_visual_two_w_selects_two_words_forward() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta gamma".to_string();
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "v2w");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((0, 11)));
    }

    #[test]
    fn test_visual_two_e_selects_to_end_of_second_word() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta gamma".to_string();
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "v2e");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((0, 10)));
    }

    // -----------------------------------------------------------------------
    // Extended spec coverage
    // -----------------------------------------------------------------------

    #[test]
    fn test_e_moves_to_end_of_word() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "e");
        assert_eq!(cursor(&te), 4);
    }

    #[test]
    fn test_big_e_moves_to_end_of_non_whitespace_run() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo, bar baz".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "E");
        assert_eq!(cursor(&te), 3);
    }

    #[test]
    fn test_ge_moves_to_end_of_previous_word() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta gamma".to_string();
        set_cursor(&mut te, 11);
        let _ = send(&mut vim, &mut text, &mut te, "ge");
        assert_eq!(cursor(&te), 9);
    }

    #[test]
    fn test_dw_deletes_to_next_word_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "dw");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key { key: Key::ArrowRight, modifiers, .. } if modifiers.alt && modifiers.shift
        )));
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_de_deletes_to_end_of_word() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "de");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key { key: Key::ArrowRight, modifiers, .. } if modifiers.alt && modifiers.shift
        )));
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_db_deletes_back_to_previous_word_start() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 6);
        let evs = send(&mut vim, &mut text, &mut te, "db");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key { key: Key::ArrowLeft, modifiers, .. } if modifiers.alt && modifiers.shift
        )));
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_cw_changes_word_and_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "cw");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_ce_changes_to_end_of_word_and_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "ce");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_yw_yanks_word_motion() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "yw");
        assert!(evs.iter().any(|e| matches!(e, Event::Copy)));
        assert_eq!(vim.yank_buffer, "alpha ");
    }

    #[test]
    fn test_ye_yanks_through_last_character_before_trailing_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello   ".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "ye");
        assert!(evs.iter().any(|e| matches!(e, Event::Copy)));
        assert_eq!(vim.yank_buffer, "hello");
    }

    #[test]
    fn test_diw_deletes_inner_word() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 2);
        let evs = send(&mut vim, &mut text, &mut te, "diw");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_daw_deletes_word_with_trailing_space() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 2);
        let evs = send(&mut vim, &mut text, &mut te, "daw");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_daw_big_word_selects_non_whitespace_run() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta gamma".to_string();
        set_cursor(&mut te, 7);
        let evs = send(&mut vim, &mut text, &mut te, "daW");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_de_selects_through_last_character_before_trailing_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello   ".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "de");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
        assert_eq!(selection(&te), Some((0, 5)));
    }

    #[test]
    fn test_ce_selects_through_last_character_before_trailing_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello   ".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "ce");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
        assert_eq!(vim.mode, VimMode::Insert);
        assert_eq!(selection(&te), Some((0, 5)));
    }

    #[test]
    fn test_ct_uses_correct_till_semantics() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc_def".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "ct_");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
        assert_eq!(vim.mode, VimMode::Insert);
        assert_eq!(selection(&te), Some((0, 3)));
    }

    #[test]
    fn test_cf_uses_correct_find_semantics() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc_def".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "cf_");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
        assert_eq!(vim.mode, VimMode::Insert);
        assert_eq!(selection(&te), Some((0, 4)));
    }

    #[test]
    fn test_ciw_changes_inner_word_and_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 2);
        let evs = send(&mut vim, &mut text, &mut te, "ciw");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_yiw_yanks_inner_word() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 2);
        let evs = send(&mut vim, &mut text, &mut te, "yiw");
        assert!(evs.iter().any(|e| matches!(e, Event::Copy)));
        assert_eq!(vim.yank_buffer, "alpha");
    }

    #[test]
    fn test_di_parens_deletes_inside_delimiters() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "(alpha beta)".to_string();
        set_cursor(&mut te, 3);
        let evs = send(&mut vim, &mut text, &mut te, "di(");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_da_parens_deletes_around_delimiters() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "(alpha beta)".to_string();
        set_cursor(&mut te, 3);
        let evs = send(&mut vim, &mut text, &mut te, "da(");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_ci_double_quotes_changes_inside_quotes() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = r#""alpha beta""#.to_string();
        set_cursor(&mut te, 3);
        let evs = send(&mut vim, &mut text, &mut te, "ci\"");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_viw_selects_inner_word() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 2);
        send(&mut vim, &mut text, &mut te, "viw");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((0, 5)));
    }

    #[test]
    fn test_vaw_selects_word_with_trailing_space() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 2);
        send(&mut vim, &mut text, &mut te, "vaw");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((0, 6)));
    }

    #[test]
    fn test_visual_inner_quotes_selects_inside_quotes() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = r#""alpha beta""#.to_string();
        set_cursor(&mut te, 3);
        send(&mut vim, &mut text, &mut te, "vi\"");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((1, 11)));
    }

    #[test]
    fn test_visual_a_quotes_selects_quotes_and_contents() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = r#""alpha beta""#.to_string();
        set_cursor(&mut te, 3);
        send(&mut vim, &mut text, &mut te, "va\"");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((0, 12)));
    }

    #[test]
    fn test_visual_e_selects_through_last_character_before_trailing_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello   ".to_string();
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "ve");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((0, 5)));
    }

    #[test]
    fn test_visual_big_e_selects_through_last_character_before_trailing_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo-bar   ".to_string();
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "vE");
        assert_eq!(vim.mode, VimMode::Visual);
        assert_eq!(selection(&te), Some((0, 7)));
    }

    #[test]
    fn test_visual_zero_selects_to_start_of_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 6);
        send(&mut vim, &mut text, &mut te, "v0");
        assert_eq!(selection(&te), Some((0, 7)));
    }

    #[test]
    fn test_visual_dollar_selects_to_end_of_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        set_cursor(&mut te, 2);
        send(&mut vim, &mut text, &mut te, "v$");
        assert_eq!(selection(&te), Some((2, text.chars().count())));
    }

    #[test]
    fn test_two_gg_jumps_to_second_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "line1\nline2\nline3".to_string();
        set_cursor(&mut te, text.chars().count());
        send(&mut vim, &mut text, &mut te, "2gg");
        assert_eq!(cursor(&te), 6);
    }

    #[test]
    fn test_two_g_uppercase_jumps_to_second_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "line1\nline2\nline3".to_string();
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "2G");
        assert_eq!(cursor(&te), 6);
    }

    #[test]
    fn test_dgg_deletes_to_start_of_file() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "line1\nline2\nline3".to_string();
        set_cursor(&mut te, 8);
        let evs = send(&mut vim, &mut text, &mut te, "dgg");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_dg_uppercase_deletes_to_end_of_file() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "line1\nline2\nline3".to_string();
        set_cursor(&mut te, 2);
        let evs = send(&mut vim, &mut text, &mut te, "dG");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_reverse_search_moves_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo bar baz bar".to_string();
        set_cursor(&mut te, text.chars().count());
        send(&mut vim, &mut text, &mut te, "?");
        send(&mut vim, &mut text, &mut te, "bar");
        press_enter(&mut vim, &mut text, &mut te);
        assert_eq!(cursor(&te), 12);
    }

    #[test]
    fn test_n_uppercase_repeats_search_backward() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo bar foo bar".to_string();
        vim.last_search = "bar".to_string();
        set_cursor(&mut te, text.chars().count());
        send(&mut vim, &mut text, &mut te, "N");
        assert_eq!(cursor(&te), 12);
    }

    #[test]
    fn test_t_motion_stops_before_target() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc,def".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "t,");
        let rights = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(rights, 2);
    }

    #[test]
    fn test_t_uppercase_motion_stops_after_target_backward() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc,def".to_string();
        set_cursor(&mut te, 6);
        let evs = send(&mut vim, &mut text, &mut te, "T,");
        let lefts = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowLeft, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(lefts, 2);
    }

    #[test]
    fn test_f_count_skips_to_nth_match() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abacad".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "2fa");
        let rights = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(rights, 4);
    }

    #[test]
    fn test_t_count_handles_repeated_punctuation_before_trailing_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc,def,ghi   ".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "2t,");
        let rights = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(rights, 6);
    }

    #[test]
    fn test_t_uppercase_count_handles_repeated_punctuation_before_trailing_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc,def,ghi   ".to_string();
        set_cursor(&mut te, text.chars().count());
        let evs = send(&mut vim, &mut text, &mut te, "2T,");
        let lefts = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowLeft, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(lefts, 10);
    }

    #[test]
    fn test_f_count_handles_repeated_punctuation_before_trailing_whitespace() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc.def..ghi   ".to_string();
        set_cursor(&mut te, 0);
        let evs = send(&mut vim, &mut text, &mut te, "2f.");
        let rights = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(rights, 7);
    }

    #[test]
    fn test_semicolon_repeats_t_motion_forward() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc,def,ghi".to_string();
        set_cursor(&mut te, 0);
        send(&mut vim, &mut text, &mut te, "t,");
        set_cursor(&mut te, 2);
        let evs = send(&mut vim, &mut text, &mut te, ";");
        let rights = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(rights, 4);
    }

    #[test]
    fn test_comma_reverses_t_motion() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "abc,def,ghi".to_string();
        set_cursor(&mut te, 8);
        send(&mut vim, &mut text, &mut te, "T,");
        set_cursor(&mut te, 5);
        let evs = send(&mut vim, &mut text, &mut te, ",");
        let rights = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(rights, 2);
    }

    #[test]
    fn test_p_uppercase_pastes_before_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        vim.yank_buffer = "world".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "P");
        assert!(!evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::ArrowRight,
                ..
            }
        )));
        assert!(evs
            .iter()
            .any(|e| matches!(e, Event::Paste(s) if s == "world")));
    }

    #[test]
    fn test_named_register_yank_writes_register() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "alpha beta".to_string();
        send(&mut vim, &mut text, &mut te, "\"ayy");
        assert_eq!(
            vim.registers.get(&'a').map(String::as_str),
            Some("alpha beta")
        );
    }

    #[test]
    fn test_macro_count_repeats_playback() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();

        send(&mut vim, &mut text, &mut te, "qa");
        send(&mut vim, &mut text, &mut te, "l");
        send(&mut vim, &mut text, &mut te, "q");

        let evs = send(&mut vim, &mut text, &mut te, "2@a");
        let rights = evs
            .iter()
            .filter(|e| matches!(e, Event::Key { key: Key::ArrowRight, modifiers, .. } if *modifiers == Modifiers::NONE))
            .count();
        assert_eq!(rights, 2);
    }

    #[test]
    fn test_macro_playback_flushes_after_visual_y_before_followup_motion() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello\nworld".to_string();
        set_cursor(&mut te, 0);
        vim.macros.insert(
            'a',
            vec![
                Event::Text("v".into()),
                Event::Text("w".into()),
                Event::Text("y".into()),
                Event::Text("w".into()),
            ],
        );

        let _ = send(&mut vim, &mut text, &mut te, "@a");
        vim.flush_pending_visual_exit(&mut te);

        assert_eq!(vim.mode, VimMode::Normal);
        assert_eq!(
            cursor(&te),
            6,
            "macro playback should treat the post-y motion as normal-mode input"
        );
    }

    #[test]
    fn test_ctrl_bracket_leaves_visual_mode() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, "v");
        ctrl_bracket(&mut vim, &mut text, &mut te);
        assert_eq!(vim.mode, VimMode::Normal);
    }

    #[test]
    fn test_ctrl_bracket_leaves_command_mode_and_clears_buffer() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        send(&mut vim, &mut text, &mut te, ":wq");
        ctrl_bracket(&mut vim, &mut text, &mut te);
        assert_eq!(vim.mode, VimMode::Normal);
        assert_eq!(vim.command_buffer, "");
    }

    #[test]
    fn test_x_uppercase_deletes_char_before_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        set_cursor(&mut te, 3);
        let evs = send(&mut vim, &mut text, &mut te, "X");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key { key: Key::ArrowLeft, modifiers, .. } if modifiers.shift
        )));
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_d_uppercase_deletes_to_end_of_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "D");
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key { key: Key::End, modifiers, .. } if modifiers.shift
        )));
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_c_uppercase_changes_to_end_of_line() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello world".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "C");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key { key: Key::End, modifiers, .. } if modifiers.shift
        )));
    }

    #[test]
    fn test_s_substitutes_char_and_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "s");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_s_uppercase_substitutes_line_and_enters_insert() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello\nworld".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "S");
        assert_eq!(vim.mode, VimMode::Insert);
        assert!(evs.iter().any(|e| matches!(
            e,
            Event::Key {
                key: Key::Backspace,
                ..
            }
        )));
    }

    #[test]
    fn test_j_uppercase_joins_lines() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "hello\nworld".to_string();
        let evs = send(&mut vim, &mut text, &mut te, "J");
        assert!(evs.iter().any(|e| matches!(e, Event::Text(t) if t == " ")));
    }

    #[test]
    fn test_percent_jumps_to_matching_delimiter() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "(alpha (beta))".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "%");
        assert_eq!(cursor(&te), text.chars().count() - 1);
    }

    #[test]
    fn test_star_searches_word_under_cursor() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo bar foo".to_string();
        set_cursor(&mut te, 4);
        let _ = send(&mut vim, &mut text, &mut te, "*");
        assert_eq!(vim.last_search, "bar");
    }

    #[test]
    fn test_hash_searches_word_under_cursor_backward() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "foo bar foo".to_string();
        set_cursor(&mut te, 8);
        let _ = send(&mut vim, &mut text, &mut te, "#");
        assert_eq!(vim.last_search, "foo");
        assert_eq!(cursor(&te), 0);
    }

    #[test]
    fn test_right_brace_moves_to_next_paragraph() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "one\n\n two\n\nthree".to_string();
        set_cursor(&mut te, 0);
        let _ = send(&mut vim, &mut text, &mut te, "}");
        assert_eq!(cursor(&te), 5);
    }

    #[test]
    fn test_left_brace_moves_to_previous_paragraph() {
        let mut vim = VimState::new();
        let mut te = TextEditState::default();
        let mut text = "one\n\n two\n\nthree".to_string();
        set_cursor(&mut te, text.chars().count());
        let _ = send(&mut vim, &mut text, &mut te, "{");
        assert_eq!(cursor(&te), 10);
    }
}
