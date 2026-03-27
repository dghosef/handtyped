use sha2::{Sha256, Digest};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use std::io::Write;
use chrono::Utc;
use serde_json::json;
use crate::signing::{load_or_create_key, sign};
use base64::Engine;

pub struct BundleInput {
    pub session_id: String,
    pub session_nonce: String,
    pub start_wall_ns: u64,
    pub log_jsonl: String,
    pub keystroke_count: usize,
}

/// Compute hex-encoded SHA-256 of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

/// Build the content of `document.rtf` from plain text (simple RTF wrapper).
pub fn make_rtf(plain_text: &str) -> String {
    let escaped = plain_text
        .replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}");
    format!(
        "{{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n\
         {{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}}\n\
         \\f0\\fs24 \\cf0 {}}}",
        escaped
    )
}

/// Compute the signing digest over all 4 data files in alphabetical filename order:
/// document.rtf → document.txt → keystroke-log.jsonl → session-meta.json
pub fn compute_digest(rtf: &[u8], txt: &[u8], log: &[u8], meta: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(sha256_hex(rtf).as_bytes());
    h.update(sha256_hex(txt).as_bytes());
    h.update(sha256_hex(log).as_bytes());
    h.update(sha256_hex(meta).as_bytes());
    h.finalize().to_vec()
}

/// Build the session-meta.json bytes.
pub fn make_meta(input: &BundleInput, doc_hash: &str) -> Vec<u8> {
    let start_secs = input.start_wall_ns / 1_000_000_000;
    let start_dt = chrono::DateTime::from_timestamp(start_secs as i64, 0)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let end_dt = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    serde_json::to_vec_pretty(&json!({
        "session_id": input.session_id,
        "session_nonce": input.session_nonce,
        "app_version": env!("CARGO_PKG_VERSION"),
        "session_start": start_dt,
        "session_end": end_dt,
        "total_keystrokes": input.keystroke_count,
        "document_content_hash": doc_hash,
    }))
    .unwrap()
}

/// Assemble and sign the bundle zip. Returns base64-encoded zip bytes.
pub fn build_and_sign(
    input: BundleInput,
    doc_text: String,
    _doc_html: String,
) -> Result<String, String> {
    let txt_bytes = doc_text.as_bytes().to_vec();
    let rtf_bytes = make_rtf(&doc_text).into_bytes();
    let log_bytes = input.log_jsonl.as_bytes().to_vec();
    let doc_hash = sha256_hex(&txt_bytes);
    let meta_bytes = make_meta(&input, &doc_hash);

    let digest = compute_digest(&rtf_bytes, &txt_bytes, &log_bytes, &meta_bytes);

    let signing_key = load_or_create_key()?;
    let sig_bytes = sign(&signing_key, &digest);
    let sig_content = hex::encode(sig_bytes);

    let mut zip_buf: Vec<u8> = Vec::new();
    {
        let mut zip = ZipWriter::new(std::io::Cursor::new(&mut zip_buf));
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let prefix = format!("session-{}/", input.session_id);

        zip.start_file(format!("{prefix}document.txt"), opts).map_err(|e| e.to_string())?;
        zip.write_all(&txt_bytes).map_err(|e| e.to_string())?;

        zip.start_file(format!("{prefix}document.rtf"), opts).map_err(|e| e.to_string())?;
        zip.write_all(&rtf_bytes).map_err(|e| e.to_string())?;

        zip.start_file(format!("{prefix}keystroke-log.jsonl"), opts).map_err(|e| e.to_string())?;
        zip.write_all(&log_bytes).map_err(|e| e.to_string())?;

        zip.start_file(format!("{prefix}session-meta.json"), opts).map_err(|e| e.to_string())?;
        zip.write_all(&meta_bytes).map_err(|e| e.to_string())?;

        zip.start_file(format!("{prefix}bundle.sig"), opts).map_err(|e| e.to_string())?;
        zip.write_all(sig_content.as_bytes()).map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(&zip_buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_hex_known() {
        let result = sha256_hex(b"abc");
        assert_eq!(result, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn test_make_rtf_escaping() {
        let rtf = make_rtf("hello {world}");
        assert!(rtf.contains("hello \\{world\\}"));
    }

    #[test]
    fn test_make_rtf_backslash() {
        let rtf = make_rtf("a\\b");
        assert!(rtf.contains("a\\\\b"));
    }

    #[test]
    fn test_compute_digest_deterministic() {
        let d1 = compute_digest(b"rtf", b"txt", b"log", b"meta");
        let d2 = compute_digest(b"rtf", b"txt", b"log", b"meta");
        assert_eq!(d1, d2);
    }

    #[test]
    fn test_compute_digest_sensitive_to_order() {
        let d1 = compute_digest(b"A", b"B", b"C", b"D");
        let d2 = compute_digest(b"B", b"A", b"C", b"D");
        assert_ne!(d1, d2);
    }

    #[test]
    fn test_make_meta_contains_fields() {
        let input = BundleInput {
            session_id: "test-id".into(),
            session_nonce: "deadbeef".into(),
            start_wall_ns: 0,
            log_jsonl: String::new(),
            keystroke_count: 42,
        };
        let meta = make_meta(&input, "abc123");
        let v: serde_json::Value = serde_json::from_slice(&meta).unwrap();
        assert_eq!(v["session_id"], "test-id");
        assert_eq!(v["total_keystrokes"], 42);
        assert_eq!(v["document_content_hash"], "abc123");
    }

    #[test]
    fn test_build_and_sign_produces_valid_zip() {
        let input = BundleInput {
            session_id: "smoke-test".into(),
            session_nonce: "cafebabe".into(),
            start_wall_ns: 1_000_000_000,
            log_jsonl: "{\"t\":1,\"type\":\"down\",\"key\":4,\"flags\":0}".into(),
            keystroke_count: 1,
        };
        let result = build_and_sign(input, "Hello world".into(), String::new());
        assert!(result.is_ok(), "export failed: {:?}", result.err());

        let zip_bytes = base64::engine::general_purpose::STANDARD
            .decode(result.unwrap())
            .unwrap();
        assert!(!zip_bytes.is_empty());

        let cursor = std::io::Cursor::new(&zip_bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n.ends_with("document.txt")));
        assert!(names.iter().any(|n| n.ends_with("keystroke-log.jsonl")));
        assert!(names.iter().any(|n| n.ends_with("session-meta.json")));
        assert!(names.iter().any(|n| n.ends_with("bundle.sig")));
    }
}
