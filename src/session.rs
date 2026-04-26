use crate::editor::EditorDocumentState;
use crate::integrity::IntegrityReport;
use crate::observability::RuntimeObservability;
use input_attestation::capture::CaptureState;
pub use input_attestation::session::{
    ExtraEvent, FocusEvent, KeyEvent, KeyboardInfo, LogEntry, SessionState,
};
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub capture: Arc<CaptureState>,
    pub editor_state: Mutex<EditorDocumentState>,
    pub integrity: IntegrityReport,
    pub observability: Mutex<RuntimeObservability>,
}

impl AppState {
    pub fn new(
        capture: Arc<CaptureState>,
        editor_state: EditorDocumentState,
        integrity: IntegrityReport,
        observability: RuntimeObservability,
    ) -> Self {
        Self {
            capture,
            editor_state: Mutex::new(editor_state),
            integrity,
            observability: Mutex::new(observability),
        }
    }

    #[cfg(test)]
    pub fn test_default() -> Self {
        Self::test_with_session(SessionState::new(0))
    }

    #[cfg(test)]
    pub fn test_with_session(session: SessionState) -> Self {
        let capture = Arc::new(CaptureState::new(session.start_mach));
        *capture.session.lock().unwrap() = session;
        Self::new(
            capture,
            EditorDocumentState::default(),
            IntegrityReport::default(),
            RuntimeObservability::default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_uses_shared_capture_state() {
        let capture = Arc::new(CaptureState::new(0));
        let state = AppState::new(
            Arc::clone(&capture),
            EditorDocumentState::default(),
            IntegrityReport::default(),
            RuntimeObservability::default(),
        );

        state
            .capture
            .session
            .lock()
            .unwrap()
            .append_extra(ExtraEvent {
                t: 42,
                kind: "focus_active".into(),
                char_count: None,
                duration_ms: None,
                content_hash: None,
            });

        assert_eq!(capture.session.lock().unwrap().log.len(), 1);
    }
}
