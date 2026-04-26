pub use input_attestation::capture::{
    input_monitoring_access, input_monitoring_access_from_raw, is_builtin_transport,
    mach_absolute_time, mach_to_wall_ns, request_input_monitoring_access, suspicious_keydown,
    CaptureState, InputMonitoringAccess, TimebaseInfo,
};

use crate::session::AppState;
use std::sync::Arc;

pub fn start_hid_capture(state: Arc<AppState>) {
    input_attestation::capture::start_hid_capture(Arc::clone(&state.capture));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::AppState;

    #[test]
    fn wrapper_preserves_capture_arc() {
        let state = Arc::new(AppState::test_default());
        let original = Arc::clone(&state.capture);
        assert!(Arc::ptr_eq(&state.capture, &original));
    }
}
