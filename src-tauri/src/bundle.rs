pub struct BundleInput {
    pub session_id: String,
    pub session_nonce: String,
    pub start_wall_ns: u64,
    pub log_jsonl: String,
    pub keystroke_count: usize,
}

pub fn build_and_sign(
    _input: BundleInput,
    _doc_text: String,
    _doc_html: String,
) -> Result<String, String> {
    Ok(String::new())
}
