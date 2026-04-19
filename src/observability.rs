use crate::integrity::IntegrityReport;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::backtrace::Backtrace;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};
use std::thread;

const OBSERVABILITY_DIR_ENV: &str = "HANDTYPED_OBSERVABILITY_DIR";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuntimeObservability {
    pub last_upload_success_at: Option<String>,
    pub last_upload_failure_at: Option<String>,
    pub last_upload_failure: Option<String>,
    pub last_crash_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthSnapshot {
    pub healthy: bool,
    pub level: String,
    pub headline: String,
    pub issues: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CrashRecord {
    timestamp: String,
    thread: String,
    message: String,
    location: Option<String>,
    backtrace: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ObservabilityEvent {
    timestamp: String,
    event: String,
    outcome: String,
    detail: Option<String>,
    session_id: Option<String>,
    document_name: Option<String>,
    url: Option<String>,
}

static PANIC_HOOK: Once = Once::new();

fn now_stamp() -> String {
    Local::now().to_rfc3339()
}

fn observability_dir() -> PathBuf {
    if let Ok(dir) = std::env::var(OBSERVABILITY_DIR_ENV) {
        return PathBuf::from(dir);
    }

    let mut dir = dirs_next::config_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    dir.push("handtyped");
    dir.push("observability");
    dir
}

fn ensure_dir(base_dir: &Path) -> PathBuf {
    let _ = fs::create_dir_all(base_dir);
    base_dir.to_path_buf()
}

fn crash_log_path(base_dir: &Path) -> PathBuf {
    ensure_dir(base_dir).join("crashes.jsonl")
}

fn last_crash_path(base_dir: &Path) -> PathBuf {
    ensure_dir(base_dir).join("last_crash.json")
}

fn event_log_path(base_dir: &Path) -> PathBuf {
    ensure_dir(base_dir).join("events.jsonl")
}

fn write_json_line(path: &Path, value: &impl Serialize) {
    if let Ok(line) = serde_json::to_string(value) {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn panic_message(info: &PanicHookInfo<'_>) -> String {
    if let Some(message) = info.payload().downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = info.payload().downcast_ref::<String>() {
        return message.clone();
    }
    "panic".to_string()
}

fn build_crash_record(info: &PanicHookInfo<'_>) -> CrashRecord {
    CrashRecord {
        timestamp: now_stamp(),
        thread: thread::current()
            .name()
            .map(str::to_owned)
            .unwrap_or_else(|| "unnamed".to_string()),
        message: panic_message(info),
        location: info.location().map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        }),
        backtrace: format!("{:?}", Backtrace::force_capture()),
    }
}

fn persist_crash_record_at(base_dir: &Path, record: &CrashRecord) {
    let last_path = last_crash_path(base_dir);
    if let Ok(json) = serde_json::to_string_pretty(record) {
        let _ = fs::write(last_path, json);
    }
    write_json_line(&crash_log_path(base_dir), record);
}

fn load_last_crash_summary_at(base_dir: &Path) -> Option<String> {
    let path = last_crash_path(base_dir);
    let content = fs::read_to_string(path).ok()?;
    let record: CrashRecord = serde_json::from_str(&content).ok()?;
    Some(record.summary())
}

fn append_event_at(base_dir: &Path, event: ObservabilityEvent) {
    write_json_line(&event_log_path(base_dir), &event);
}

impl CrashRecord {
    fn summary(&self) -> String {
        match &self.location {
            Some(location) => format!("{} at {} ({})", self.message, location, self.timestamp),
            None => format!("{} ({})", self.message, self.timestamp),
        }
    }
}

impl RuntimeObservability {
    pub fn load_from_disk() -> Self {
        Self {
            last_crash_summary: load_last_crash_summary_at(&observability_dir()),
            ..Self::default()
        }
    }

    pub fn health_snapshot(&self, integrity: &IntegrityReport, hid_active: bool) -> HealthSnapshot {
        let mut issues = Vec::new();
        if !hid_active {
            issues.push("Input Monitoring is not active".to_string());
        }
        if !integrity.code_signing_valid {
            issues.push("Code signature is invalid".to_string());
        }
        if integrity.frida_detected {
            issues.push("Frida detected".to_string());
        }
        if integrity.dylib_injection_detected {
            issues.push("Injected dylib detected".to_string());
        }
        if integrity.dyld_env_injection {
            issues.push("DYLD injection environment variables detected".to_string());
        }
        if let Some(failure) = &self.last_upload_failure {
            issues.push(format!("Last replay upload failed: {failure}"));
        }

        let mut notes = Vec::new();
        if let Some(crash) = &self.last_crash_summary {
            notes.push(format!("Recovered from previous crash: {crash}"));
        }

        let healthy = issues.is_empty();
        HealthSnapshot {
            healthy,
            level: if healthy {
                "healthy".to_string()
            } else {
                "degraded".to_string()
            },
            headline: if healthy {
                "OK".to_string()
            } else {
                "Needs attention".to_string()
            },
            issues,
            notes,
        }
    }
}

pub fn install_panic_hook() {
    PANIC_HOOK.call_once(|| {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            let record = build_crash_record(panic_info);
            persist_crash_record_at(&observability_dir(), &record);
            eprintln!("[handtyped] crash: {}", record.summary());
            previous_hook(panic_info);
        }));
    });
}

pub fn record_upload_success(
    observability: &Mutex<RuntimeObservability>,
    session_id: Option<&str>,
    document_name: Option<&str>,
    url: Option<&str>,
) {
    let mut obs = observability.lock().unwrap();
    obs.last_upload_success_at = Some(now_stamp());
    obs.last_upload_failure_at = None;
    obs.last_upload_failure = None;
    append_event_at(
        &observability_dir(),
        ObservabilityEvent {
            timestamp: now_stamp(),
            event: "replay.upload".to_string(),
            outcome: "success".to_string(),
            detail: None,
            session_id: session_id.map(str::to_owned),
            document_name: document_name.map(str::to_owned),
            url: url.map(str::to_owned),
        },
    );
}

pub fn record_upload_failure(
    observability: &Mutex<RuntimeObservability>,
    session_id: Option<&str>,
    document_name: Option<&str>,
    detail: &str,
) {
    let mut obs = observability.lock().unwrap();
    obs.last_upload_failure_at = Some(now_stamp());
    obs.last_upload_failure = Some(detail.to_string());
    append_event_at(
        &observability_dir(),
        ObservabilityEvent {
            timestamp: now_stamp(),
            event: "replay.upload".to_string(),
            outcome: "failure".to_string(),
            detail: Some(detail.to_string()),
            session_id: session_id.map(str::to_owned),
            document_name: document_name.map(str::to_owned),
            url: None,
        },
    );
}

pub fn record_crash_for_test(base_dir: &Path, summary: &str) {
    let record = CrashRecord {
        timestamp: now_stamp(),
        thread: "test".to_string(),
        message: summary.to_string(),
        location: Some("test:0:0".to_string()),
        backtrace: "test backtrace".to_string(),
    };
    persist_crash_record_at(base_dir, &record);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn crash_record_round_trips_to_summary() {
        let dir = tempdir().unwrap();
        record_crash_for_test(dir.path(), "boom");
        let summary = load_last_crash_summary_at(dir.path()).unwrap();
        assert!(summary.contains("boom"));
        assert!(summary.contains("test:0:0"));
    }

    #[test]
    fn health_snapshot_marks_upload_failure_as_needing_attention() {
        let obs = RuntimeObservability {
            last_upload_success_at: None,
            last_upload_failure_at: Some("now".into()),
            last_upload_failure: Some("Replay server returned an error: 400 Bad Request".into()),
            last_crash_summary: None,
        };
        let report = IntegrityReport {
            sip_enabled: true,
            vm_detected: false,
            hardware_model: "MacBookPro".into(),
            os_version: "14.0".into(),
            hardware_uuid: "uuid".into(),
            app_binary_hash: "hash".into(),
            code_signing_valid: true,
            frida_detected: false,
            dylib_injection_detected: false,
            dyld_env_injection: false,
        };

        let health = obs.health_snapshot(&report, true);
        assert!(!health.healthy);
        assert_eq!(health.level, "degraded");
        assert!(health
            .issues
            .iter()
            .any(|issue| issue.contains("Last replay upload failed")));
    }

    #[test]
    fn health_snapshot_is_ok_for_clean_runtime() {
        let obs = RuntimeObservability::default();
        let report = IntegrityReport {
            sip_enabled: true,
            vm_detected: false,
            hardware_model: "MacBookPro".into(),
            os_version: "14.0".into(),
            hardware_uuid: "uuid".into(),
            app_binary_hash: "hash".into(),
            code_signing_valid: true,
            frida_detected: false,
            dylib_injection_detected: false,
            dyld_env_injection: false,
        };

        let health = obs.health_snapshot(&report, true);
        assert!(health.healthy);
        assert_eq!(health.headline, "OK");
        assert!(health.issues.is_empty());
    }
}
