# Keystroke Attestation Word Processor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native macOS Tauri app that captures keystrokes via IOHIDManager, logs them with nanosecond timestamps, and exports a cryptographically signed attestation bundle.

**Architecture:** Rust backend uses IOKit's IOHIDManager (FFI) running on a dedicated CFRunLoop thread to capture all keyboard HID events; a ProseMirror editor runs in the WebView and sends paste/focus-loss events to Rust via Tauri commands; on export, the Rust backend assembles a zip bundle containing the document, keystroke log, session metadata, and an Ed25519 signature over all files.

**Tech Stack:** Tauri 2.x, Rust, IOKit (FFI), ProseMirror (vanilla JS), ed25519-dalek, security-framework (Keychain), sha2, zip, serde_json, uuid, Vite

---

## File Map

```
/Users/dghosef/editor/
  package.json                        # frontend deps + tauri CLI
  vite.config.js                      # Vite config
  index.html                          # entry HTML
  src/
    editor.js                         # ProseMirror setup + event wiring
    ui.js                             # word count, timer, dark mode
  src-tauri/
    Cargo.toml                        # Rust deps
    build.rs                          # links IOKit + CoreFoundation frameworks
    tauri.conf.json                   # Tauri 2.x config
    capabilities/
      default.json                    # Tauri capability permissions
    src/
      main.rs                         # entry: build app, register state+commands
      lib.rs                          # run() fn called by main.rs
      session.rs                      # KeyEvent, ExtraEvent, SessionState
      hid.rs                          # IOKit FFI + IOHIDManager capture thread
      commands.rs                     # Tauri #[command] handlers
      bundle.rs                       # zip assembly + SHA-256 digest
      signing.rs                      # Ed25519 keygen, Keychain, sign
```

---

## Task 1: Scaffold Tauri 2.x project

**Files:**
- Create: `package.json`
- Create: `vite.config.js`
- Create: `index.html`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`

- [ ] **Step 1: Remove the old client directory remnants**

```bash
rm -rf /Users/dghosef/editor/client
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "humanproof",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "prosemirror-commands": "^1.5.2",
    "prosemirror-history": "^1.3.2",
    "prosemirror-keymap": "^1.2.2",
    "prosemirror-model": "^1.22.3",
    "prosemirror-schema-basic": "^1.2.3",
    "prosemirror-schema-list": "^1.3.0",
    "prosemirror-state": "^1.4.3",
    "prosemirror-view": "^1.33.8"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "vite": "^5.3.1"
  }
}
```

- [ ] **Step 3: Create `vite.config.js`**

```js
import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
```

- [ ] **Step 4: Create `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HumanProof</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f9fafb; }
    #app { max-width: 800px; margin: 0 auto; padding: 2rem; }
    #toolbar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
    #toolbar button { padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; font-size: 0.85rem; }
    #toolbar button:hover { background: #f3f4f6; }
    #stats { margin-left: auto; font-size: 0.8rem; color: #6b7280; display: flex; gap: 1rem; }
    #editor { min-height: 60vh; border: 1px solid #d1d5db; padding: 2rem; font-size: 1.1rem; line-height: 1.8; background: white; border-radius: 4px; cursor: text; outline: none; }
    #editor:focus-within { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
    .ProseMirror { outline: none; min-height: 100%; }
    .ProseMirror p { margin-bottom: 0.75em; }
    .ProseMirror h1 { font-size: 1.8em; font-weight: 700; margin-bottom: 0.5em; }
    .ProseMirror h2 { font-size: 1.4em; font-weight: 600; margin-bottom: 0.5em; }
    body.dark { background: #111827; color: #f9fafb; }
    body.dark #editor { background: #1f2937; border-color: #374151; color: #f9fafb; }
    body.dark #toolbar button { background: #374151; border-color: #4b5563; color: #f9fafb; }
    body.dark #toolbar button:hover { background: #4b5563; }
    #status-bar { margin-top: 0.5rem; font-size: 0.75rem; color: #9ca3af; display: flex; gap: 1rem; }
  </style>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <button id="btn-bold"><b>B</b></button>
      <button id="btn-italic"><i>I</i></button>
      <button id="btn-h1">H1</button>
      <button id="btn-h2">H2</button>
      <button id="btn-undo">↩ Undo</button>
      <button id="btn-redo">↪ Redo</button>
      <div id="stats">
        <span id="word-count">0 words</span>
        <span id="timer">00:00</span>
        <button id="btn-dark">🌙</button>
        <button id="btn-export">Export Bundle</button>
      </div>
    </div>
    <div id="editor"></div>
    <div id="status-bar">
      <span id="save-status">Not saved</span>
      <span id="keystroke-count">0 keystrokes</span>
    </div>
  </div>
  <script type="module" src="/src/editor.js"></script>
</body>
</html>
```

- [ ] **Step 5: Create `src-tauri/Cargo.toml`**

```toml
[package]
name = "humanproof"
version = "0.1.0"
edition = "2021"

[lib]
name = "humanproof_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
sha2 = "0.10"
hex = "0.4"
zip = "2"
chrono = { version = "0.4", features = ["serde"] }
rand = "0.8"
ed25519-dalek = { version = "2", features = ["rand_core"] }

[target.'cfg(target_os = "macos")'.dependencies]
core-foundation = "0.9"
core-foundation-sys = "0.8"
security-framework = "2"

[profile.release]
panic = "abort"
codegen-units = 1
lto = true
opt-level = "s"
strip = true
```

- [ ] **Step 6: Create `src-tauri/build.rs`**

```rust
fn main() {
    println!("cargo:rustc-link-lib=framework=IOKit");
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
    tauri_build::build()
}
```

- [ ] **Step 7: Create `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "HumanProof",
  "version": "0.1.0",
  "identifier": "com.humanproof.app",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "HumanProof",
        "width": 960,
        "height": 760,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": []
  },
  "plugins": {
    "dialog": {}
  }
}
```

- [ ] **Step 8: Create `src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for HumanProof",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default"
  ]
}
```

- [ ] **Step 9: Create `src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    humanproof_lib::run();
}
```

- [ ] **Step 10: Create `src-tauri/src/lib.rs`** (stub — will be filled in Task 4)

```rust
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 11: Install npm deps and verify it compiles**

```bash
cd /Users/dghosef/editor && npm install && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: compilation succeeds (warnings OK, no errors).

- [ ] **Step 12: Commit scaffold**

```bash
cd /Users/dghosef/editor
git add package.json vite.config.js index.html src-tauri/ src/
git commit -m "chore: scaffold Tauri 2.x project structure"
```

---

## Task 2: Session state types

**Files:**
- Create: `src-tauri/src/session.rs`

- [ ] **Step 1: Write the tests first**

Create `src-tauri/src/session.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use uuid::Uuid;
use chrono::Utc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEvent {
    /// Wall-clock nanoseconds since Unix epoch
    pub t: u64,
    /// "down" or "up"
    #[serde(rename = "type")]
    pub kind: String,
    /// HID usage code (keyboard/keypad page 0x07)
    pub key: u32,
    /// Modifier bitmask: bit0=shift, bit1=ctrl, bit2=alt, bit3=cmd
    pub flags: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtraEvent {
    pub t: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LogEntry {
    Key(KeyEvent),
    Extra(ExtraEvent),
}

pub struct SessionState {
    pub session_id: String,
    pub session_nonce: String,
    pub start_wall_ns: u64,
    /// mach_absolute_time() at session start (used for timestamp conversion)
    pub start_mach: u64,
    pub log: Vec<LogEntry>,
}

impl SessionState {
    pub fn new(start_mach: u64) -> Self {
        let start_wall_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64;

        let nonce_bytes: [u8; 32] = rand::random();

        Self {
            session_id: Uuid::new_v4().to_string(),
            session_nonce: hex::encode(nonce_bytes),
            start_wall_ns,
            start_mach,
            log: Vec::new(),
        }
    }

    pub fn append_key(&mut self, event: KeyEvent) {
        self.log.push(LogEntry::Key(event));
    }

    pub fn append_extra(&mut self, event: ExtraEvent) {
        self.log.push(LogEntry::Extra(event));
    }

    pub fn keystroke_count(&self) -> usize {
        self.log.iter().filter(|e| matches!(e, LogEntry::Key(_))).count()
    }

    pub fn to_jsonl(&self) -> String {
        self.log
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Shared state across Tauri commands and HID thread
pub struct AppState {
    pub session: Mutex<SessionState>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_event_serializes() {
        let e = KeyEvent { t: 1_000_000, kind: "down".into(), key: 4, flags: 0 };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"type\":\"down\""));
        assert!(json.contains("\"key\":4"));
    }

    #[test]
    fn test_extra_event_no_nulls() {
        let e = ExtraEvent { t: 1_000, kind: "paste".into(), char_count: Some(10), duration_ms: None };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"char_count\":10"));
        assert!(!json.contains("duration_ms"));
    }

    #[test]
    fn test_session_keystroke_count() {
        let mut s = SessionState::new(0);
        s.append_key(KeyEvent { t: 1, kind: "down".into(), key: 4, flags: 0 });
        s.append_key(KeyEvent { t: 2, kind: "up".into(), key: 4, flags: 0 });
        s.append_extra(ExtraEvent { t: 3, kind: "paste".into(), char_count: Some(5), duration_ms: None });
        assert_eq!(s.keystroke_count(), 2);
    }

    #[test]
    fn test_to_jsonl() {
        let mut s = SessionState::new(0);
        s.append_key(KeyEvent { t: 1, kind: "down".into(), key: 4, flags: 0 });
        s.append_extra(ExtraEvent { t: 2, kind: "paste".into(), char_count: Some(3), duration_ms: None });
        let jsonl = s.to_jsonl();
        let lines: Vec<&str> = jsonl.lines().collect();
        assert_eq!(lines.len(), 2);
        // Each line must be valid JSON
        serde_json::from_str::<serde_json::Value>(lines[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(lines[1]).unwrap();
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd /Users/dghosef/editor && cargo test --manifest-path src-tauri/Cargo.toml session 2>&1 | tail -20
```

Expected: `test result: ok. 4 passed; 0 failed`

- [ ] **Step 3: Commit**

```bash
cd /Users/dghosef/editor
git add src-tauri/src/session.rs
git commit -m "feat: add session state types and JSONL serialization"
```

---

## Task 3: IOKit FFI declarations and mach time conversion

**Files:**
- Create: `src-tauri/src/hid.rs` (FFI declarations only — capture loop added in Task 4)

- [ ] **Step 1: Write the mach time conversion test first**

Create `src-tauri/src/hid.rs`:

```rust
use std::ffi::c_void;
use std::os::raw::{c_long, c_uint};

// ---------------------------------------------------------------------------
// Opaque IOKit types
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct OpaqueIOHIDManager(c_void);
pub type IOHIDManagerRef = *mut OpaqueIOHIDManager;

#[repr(C)]
pub struct OpaqueIOHIDValue(c_void);
pub type IOHIDValueRef = *mut OpaqueIOHIDValue;

#[repr(C)]
pub struct OpaqueIOHIDElement(c_void);
pub type IOHIDElementRef = *mut OpaqueIOHIDElement;

pub type IOOptionBits = c_uint;
pub type IOReturn = i32;

pub type IOHIDValueCallback = unsafe extern "C" fn(
    context: *mut c_void,
    result: IOReturn,
    sender: *mut c_void,
    value: IOHIDValueRef,
);

// ---------------------------------------------------------------------------
// IOKit + mach_time FFI
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct MachTimebaseInfo {
    pub numer: u32,
    pub denom: u32,
}

extern "C" {
    pub fn mach_absolute_time() -> u64;
    pub fn mach_timebase_info(info: *mut MachTimebaseInfo) -> u32;
}

// IOKit framework functions (linked via build.rs)
extern "C" {
    pub fn IOHIDManagerCreate(
        allocator: *const c_void,
        options: IOOptionBits,
    ) -> IOHIDManagerRef;

    pub fn IOHIDManagerSetDeviceMatchingMultiple(
        manager: IOHIDManagerRef,
        multiple: core_foundation_sys::array::CFArrayRef,
    );

    pub fn IOHIDManagerRegisterInputValueCallback(
        manager: IOHIDManagerRef,
        callback: IOHIDValueCallback,
        context: *mut c_void,
    );

    pub fn IOHIDManagerScheduleWithRunLoop(
        manager: IOHIDManagerRef,
        run_loop: core_foundation_sys::runloop::CFRunLoopRef,
        run_loop_mode: core_foundation_sys::string::CFStringRef,
    );

    pub fn IOHIDManagerOpen(manager: IOHIDManagerRef, options: IOOptionBits) -> IOReturn;

    pub fn IOHIDValueGetIntegerValue(value: IOHIDValueRef) -> c_long;
    pub fn IOHIDValueGetTimeStamp(value: IOHIDValueRef) -> u64;
    pub fn IOHIDValueGetElement(value: IOHIDValueRef) -> IOHIDElementRef;
    pub fn IOHIDElementGetUsage(element: IOHIDElementRef) -> u32;
    pub fn IOHIDElementGetUsagePage(element: IOHIDElementRef) -> u32;
}

// ---------------------------------------------------------------------------
// Mach time → wall-clock nanoseconds conversion
// ---------------------------------------------------------------------------

pub struct TimebaseInfo {
    pub numer: u32,
    pub denom: u32,
}

impl TimebaseInfo {
    pub fn get() -> Self {
        let mut info = MachTimebaseInfo { numer: 0, denom: 0 };
        unsafe { mach_timebase_info(&mut info) };
        Self { numer: info.numer, denom: info.denom }
    }
}

/// Convert a mach_absolute_time timestamp (from IOHIDValueGetTimeStamp) to
/// wall-clock nanoseconds since Unix epoch.
///
/// # Arguments
/// * `event_mach` — IOHIDValueGetTimeStamp() output
/// * `start_mach` — mach_absolute_time() recorded at session start
/// * `start_wall_ns` — SystemTime::now() in ns since epoch at session start
/// * `tb` — mach timebase info
pub fn mach_to_wall_ns(
    event_mach: u64,
    start_mach: u64,
    start_wall_ns: u64,
    tb: &TimebaseInfo,
) -> u64 {
    let delta_mach = event_mach.saturating_sub(start_mach);
    // Use u128 to avoid overflow in intermediate multiplication
    let delta_ns = (delta_mach as u128 * tb.numer as u128 / tb.denom as u128) as u64;
    start_wall_ns.saturating_add(delta_ns)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mach_to_wall_ns_zero_delta() {
        let tb = TimebaseInfo { numer: 1, denom: 1 };
        let result = mach_to_wall_ns(1000, 1000, 5_000_000_000, &tb);
        assert_eq!(result, 5_000_000_000);
    }

    #[test]
    fn test_mach_to_wall_ns_positive_delta() {
        // numer=1, denom=1 → 1 mach tick = 1 ns
        let tb = TimebaseInfo { numer: 1, denom: 1 };
        let result = mach_to_wall_ns(2000, 1000, 5_000_000_000, &tb);
        assert_eq!(result, 5_000_001_000);
    }

    #[test]
    fn test_mach_to_wall_ns_apple_silicon_typical() {
        // Apple Silicon: numer=125, denom=3  → 1 mach tick ≈ 41.67 ns
        let tb = TimebaseInfo { numer: 125, denom: 3 };
        // 3 ticks = 125 ns
        let result = mach_to_wall_ns(1003, 1000, 0, &tb);
        assert_eq!(result, 125);
    }

    #[test]
    fn test_mach_to_wall_ns_no_underflow() {
        // event_mach < start_mach (clock skew / wrong values) → saturates to start
        let tb = TimebaseInfo { numer: 1, denom: 1 };
        let result = mach_to_wall_ns(500, 1000, 5_000_000_000, &tb);
        assert_eq!(result, 5_000_000_000);
    }
}
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/dghosef/editor && cargo test --manifest-path src-tauri/Cargo.toml hid 2>&1 | tail -15
```

Expected: `test result: ok. 4 passed; 0 failed`

- [ ] **Step 3: Commit**

```bash
cd /Users/dghosef/editor
git add src-tauri/src/hid.rs
git commit -m "feat: add IOKit FFI declarations and mach time conversion"
```

---

## Task 4: IOHIDManager capture thread + AppState wiring

**Files:**
- Modify: `src-tauri/src/hid.rs` (add `start_hid_capture`)
- Modify: `src-tauri/src/lib.rs` (wire AppState + HID thread)

- [ ] **Step 1: Add `start_hid_capture` to `hid.rs`**

Append to the bottom of `src-tauri/src/hid.rs` (after the existing tests block):

```rust
use core_foundation::dictionary::{CFDictionary, CFMutableDictionary};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation::base::{TCFType, kCFAllocatorDefault};
use core_foundation::array::CFArray;
use core_foundation_sys::runloop::{CFRunLoopRun, CFRunLoopGetCurrent};
use core_foundation_sys::string::CFStringRef;
use std::sync::{Arc, Mutex};
use crate::session::{AppState, KeyEvent};

// HID usage page for keyboard/keypad
const K_HID_PAGE_KEYBOARD: u32 = 0x07;

// kIOHIDDeviceUsagePageKey / kIOHIDDeviceUsageKey string literals
const K_USAGE_PAGE_KEY: &str = "DeviceUsagePage";
const K_USAGE_KEY: &str = "DeviceUsage";
// Generic Desktop page = 0x01, Keyboard usage = 0x06
const K_HID_USAGE_GD_KEYBOARD: i32 = 0x06;
const K_HID_PAGE_GENERIC_DESKTOP: i32 = 0x01;

// kIOHIDOptionsTypeNone
const K_OPTIONS_NONE: IOOptionBits = 0;

/// Context passed through the C callback
struct CallbackContext {
    state: Arc<AppState>,
    start_mach: u64,
    start_wall_ns: u64,
    tb: TimebaseInfo,
}

unsafe extern "C" fn hid_input_callback(
    context: *mut c_void,
    _result: IOReturn,
    _sender: *mut c_void,
    value: IOHIDValueRef,
) {
    if context.is_null() || value.is_null() { return; }

    let ctx = &*(context as *const CallbackContext);

    let element = IOHIDValueGetElement(value);
    if element.is_null() { return; }

    // Only process keyboard/keypad usage page events
    let usage_page = IOHIDElementGetUsagePage(element);
    if usage_page != K_HID_PAGE_KEYBOARD { return; }

    let usage = IOHIDElementGetUsage(element);
    // Skip modifier-only keys that produce no character (usage 0 is invalid)
    if usage == 0 { return; }

    let int_val = IOHIDValueGetIntegerValue(value);
    let kind = if int_val != 0 { "down" } else { "up" };

    let mach_ts = IOHIDValueGetTimeStamp(value);
    let wall_ns = mach_to_wall_ns(mach_ts, ctx.start_mach, ctx.start_wall_ns, &ctx.tb);

    // Modifier flags: IOKit doesn't expose them directly on the value;
    // we record 0 for now (flags require querying the event's modifier elements separately)
    let event = KeyEvent { t: wall_ns, kind: kind.into(), key: usage, flags: 0 };

    if let Ok(mut s) = ctx.state.session.lock() {
        s.append_key(event);
    }
}

/// Spawns a dedicated thread that runs an IOHIDManager on its own CFRunLoop.
/// Returns immediately; the thread runs until the process exits.
///
/// # Safety
/// Must be called once. The `state` Arc must live for the process lifetime.
pub fn start_hid_capture(state: Arc<AppState>) {
    std::thread::Builder::new()
        .name("hid-capture".into())
        .spawn(move || {
            unsafe {
                // Record time anchor
                let start_mach = mach_absolute_time();
                let start_wall_ns = state.session.lock().unwrap().start_wall_ns;
                let tb = TimebaseInfo::get();

                // Build device matching dictionary: GenericDesktop / Keyboard
                let usage_page_key = CFString::new(K_USAGE_PAGE_KEY);
                let usage_key = CFString::new(K_USAGE_KEY);
                let page_val = CFNumber::from(K_HID_PAGE_GENERIC_DESKTOP);
                let usage_val = CFNumber::from(K_HID_USAGE_GD_KEYBOARD);

                let matching: CFDictionary<CFString, CFNumber> = CFDictionary::from_CFType_pairs(&[
                    (usage_page_key, page_val),
                    (usage_key, usage_val),
                ]);

                let matching_array = CFArray::from_CFTypes(&[matching]);

                let manager = IOHIDManagerCreate(kCFAllocatorDefault as *const c_void, K_OPTIONS_NONE);
                if manager.is_null() {
                    eprintln!("IOHIDManagerCreate failed");
                    return;
                }

                IOHIDManagerSetDeviceMatchingMultiple(manager, matching_array.as_concrete_TypeRef());

                // Box the context so it has a stable address for the lifetime of the thread
                let ctx = Box::new(CallbackContext {
                    state,
                    start_mach,
                    start_wall_ns,
                    tb,
                });
                let ctx_ptr = Box::into_raw(ctx) as *mut c_void;

                IOHIDManagerRegisterInputValueCallback(manager, hid_input_callback, ctx_ptr);

                let run_loop = CFRunLoopGetCurrent();
                // kCFRunLoopDefaultMode as a raw CFStringRef
                let mode: CFStringRef = core_foundation_sys::runloop::kCFRunLoopDefaultMode;
                IOHIDManagerScheduleWithRunLoop(manager, run_loop, mode);

                let ret = IOHIDManagerOpen(manager, K_OPTIONS_NONE);
                if ret != 0 {
                    eprintln!("IOHIDManagerOpen failed: {}", ret);
                    return;
                }

                // Run forever — blocks this thread
                CFRunLoopRun();
            }
        })
        .expect("failed to spawn hid-capture thread");
}
```

- [ ] **Step 2: Update `src-tauri/src/lib.rs`** to wire AppState and start capture

```rust
use std::sync::{Arc, Mutex};

mod session;
mod hid;
mod commands;
mod bundle;
mod signing;

use session::{AppState, SessionState};

pub fn run() {
    // Record mach time as early as possible for accurate timestamp anchoring
    let start_mach = unsafe { hid::mach_absolute_time() };

    let state = Arc::new(AppState {
        session: Mutex::new(SessionState::new(start_mach)),
    });

    let state_for_hid = Arc::clone(&state);
    hid::start_hid_capture(state_for_hid);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::log_paste_event,
            commands::log_focus_loss_event,
            commands::get_keystroke_count,
            commands::save_session,
            commands::export_bundle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Create stub `src-tauri/src/commands.rs`** (will be filled in Task 5)

```rust
use tauri::State;
use std::sync::Arc;
use crate::session::AppState;

#[tauri::command]
pub fn log_paste_event(_state: State<Arc<AppState>>) {}

#[tauri::command]
pub fn log_focus_loss_event(_state: State<Arc<AppState>>) {}

#[tauri::command]
pub fn get_keystroke_count(_state: State<Arc<AppState>>) -> usize { 0 }

#[tauri::command]
pub fn save_session(_state: State<Arc<AppState>>) {}

#[tauri::command]
pub fn export_bundle(_state: State<Arc<AppState>>) -> Result<String, String> { Ok(String::new()) }
```

- [ ] **Step 4: Create stub `src-tauri/src/bundle.rs`**

```rust
// Filled in Task 8
```

- [ ] **Step 5: Create stub `src-tauri/src/signing.rs`**

```rust
// Filled in Task 7
```

- [ ] **Step 6: Add module declarations to `session.rs`**

Ensure `session.rs` has `use rand;` satisfied — add `rand` import at top of file if not present. The `rand::random()` call in `SessionState::new` requires the `rand` crate.

- [ ] **Step 7: Verify it compiles**

```bash
cd /Users/dghosef/editor && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error" | head -20
```

Expected: no `error` lines.

- [ ] **Step 8: Commit**

```bash
cd /Users/dghosef/editor
git add src-tauri/src/
git commit -m "feat: IOHIDManager capture thread wired into Tauri AppState"
```

---

## Task 5: Tauri commands (paste, focus-loss, save, keystroke count)

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Write the paste/focus command implementations**

Replace `src-tauri/src/commands.rs` with:

```rust
use tauri::State;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use std::fs;
use crate::session::{AppState, ExtraEvent};
use crate::bundle;

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
}

fn session_dir(session_id: &str) -> std::path::PathBuf {
    let mut path = dirs_next::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    path.push("humanproof");
    path.push("sessions");
    path.push(session_id);
    path
}

#[tauri::command]
pub fn log_paste_event(char_count: usize, state: State<Arc<AppState>>) {
    let mut s = state.session.lock().unwrap();
    s.append_extra(ExtraEvent {
        t: now_ns(),
        kind: "paste".into(),
        char_count: Some(char_count),
        duration_ms: None,
    });
}

#[tauri::command]
pub fn log_focus_loss_event(duration_ms: u64, state: State<Arc<AppState>>) {
    let mut s = state.session.lock().unwrap();
    s.append_extra(ExtraEvent {
        t: now_ns(),
        kind: "focus_loss".into(),
        char_count: None,
        duration_ms: Some(duration_ms),
    });
}

#[tauri::command]
pub fn get_keystroke_count(state: State<Arc<AppState>>) -> usize {
    state.session.lock().unwrap().keystroke_count()
}

#[tauri::command]
pub fn save_session(state: State<Arc<AppState>>) -> Result<(), String> {
    let s = state.session.lock().unwrap();
    let dir = session_dir(&s.session_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log_path = dir.join("keystroke-log.jsonl");
    fs::write(&log_path, s.to_jsonl()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn export_bundle(
    doc_text: String,
    doc_html: String,
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let session = {
        let s = state.session.lock().unwrap();
        bundle::BundleInput {
            session_id: s.session_id.clone(),
            session_nonce: s.session_nonce.clone(),
            start_wall_ns: s.start_wall_ns,
            log_jsonl: s.to_jsonl(),
            keystroke_count: s.keystroke_count(),
        }
    };
    bundle::build_and_sign(session, doc_text, doc_html)
}
```

- [ ] **Step 2: Add `dirs-next` to Cargo.toml**

Add to `[dependencies]` in `src-tauri/Cargo.toml`:

```toml
dirs-next = "2"
```

- [ ] **Step 3: Verify compilation**

```bash
cd /Users/dghosef/editor && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -10
```

Expected: no errors (bundle::build_and_sign not yet defined — will produce a compile error; stub it next).

- [ ] **Step 4: Add stub to `bundle.rs`**

Replace `src-tauri/src/bundle.rs` with:

```rust
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
    Ok(String::new()) // stub
}
```

- [ ] **Step 5: Verify it compiles**

```bash
cd /Users/dghosef/editor && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -10
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/dghosef/editor
git add src-tauri/
git commit -m "feat: Tauri commands for paste/focus events, save, and export stub"
```

---

## Task 6: ProseMirror editor frontend

**Files:**
- Create: `src/editor.js`
- Create: `src/ui.js`

- [ ] **Step 1: Create `src/ui.js`**

```js
// Word count, session timer, dark mode, status bar updates

let _startTime = Date.now()
let _timerInterval = null

export function initUI() {
  _startTime = Date.now()
  _timerInterval = setInterval(updateTimer, 1000)

  document.getElementById('btn-dark').addEventListener('click', () => {
    document.body.classList.toggle('dark')
  })
}

export function updateWordCount(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  document.getElementById('word-count').textContent = `${words} word${words !== 1 ? 's' : ''}`
}

export function updateKeystrokeCount(count) {
  document.getElementById('keystroke-count').textContent = `${count} keystrokes`
}

export function setSaveStatus(msg) {
  document.getElementById('save-status').textContent = msg
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - _startTime) / 1000)
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const s = String(elapsed % 60).padStart(2, '0')
  document.getElementById('timer').textContent = `${m}:${s}`
}

export function teardownUI() {
  if (_timerInterval) clearInterval(_timerInterval)
}
```

- [ ] **Step 2: Create `src/editor.js`**

```js
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, toggleMark, setBlockType } from 'prosemirror-commands'
import { schema } from 'prosemirror-schema-basic'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { initUI, updateWordCount, updateKeystrokeCount, setSaveStatus } from './ui.js'

// ---------------------------------------------------------------------------
// Focus loss tracking
// ---------------------------------------------------------------------------

let _focusLostAt = null

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _focusLostAt = Date.now()
  } else if (_focusLostAt !== null) {
    const duration_ms = Date.now() - _focusLostAt
    _focusLostAt = null
    invoke('log_focus_loss_event', { duration_ms }).catch(console.error)
  }
})

window.addEventListener('blur', () => {
  if (_focusLostAt === null) _focusLostAt = Date.now()
})

window.addEventListener('focus', () => {
  if (_focusLostAt !== null) {
    const duration_ms = Date.now() - _focusLostAt
    _focusLostAt = null
    invoke('log_focus_loss_event', { duration_ms }).catch(console.error)
  }
})

// ---------------------------------------------------------------------------
// ProseMirror setup
// ---------------------------------------------------------------------------

function buildEditor() {
  const state = EditorState.create({
    schema,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
      keymap(baseKeymap),
    ],
  })

  const view = new EditorView(document.getElementById('editor'), {
    state,
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr)
      view.updateState(newState)
      if (tr.docChanged) {
        updateWordCount(newState.doc.textContent)
      }
    },
    handleDOMEvents: {
      paste(view, event) {
        const text = event.clipboardData?.getData('text/plain') ?? ''
        invoke('log_paste_event', { char_count: text.length }).catch(console.error)
        // Allow paste to proceed (not blocked)
        return false
      },
    },
  })

  return view
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function wireToolbar(view) {
  const { bold, italic } = schema.marks
  const { heading, paragraph } = schema.nodes

  document.getElementById('btn-bold').addEventListener('click', () => {
    toggleMark(bold)(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-italic').addEventListener('click', () => {
    toggleMark(italic)(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-h1').addEventListener('click', () => {
    setBlockType(heading, { level: 1 })(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-h2').addEventListener('click', () => {
    setBlockType(heading, { level: 2 })(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-undo').addEventListener('click', () => {
    undo(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-redo').addEventListener('click', () => {
    redo(view.state, view.dispatch)
    view.focus()
  })
}

// ---------------------------------------------------------------------------
// Auto-save (every 30s)
// ---------------------------------------------------------------------------

function startAutosave() {
  return setInterval(async () => {
    try {
      await invoke('save_session')
      setSaveStatus(`Saved ${new Date().toLocaleTimeString()}`)
    } catch (e) {
      setSaveStatus('Save failed')
    }
  }, 30_000)
}

// ---------------------------------------------------------------------------
// Keystroke count polling (every 2s)
// ---------------------------------------------------------------------------

function startKeystrokePoller() {
  return setInterval(async () => {
    try {
      const count = await invoke('get_keystroke_count')
      updateKeystrokeCount(count)
    } catch (_) {}
  }, 2_000)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function handleExport(view) {
  const docText = view.state.doc.textContent
  // Serialize doc to HTML for RTF conversion in Rust
  const tmp = document.createElement('div')
  const { DOMSerializer } = await import('prosemirror-model')
  const serializer = DOMSerializer.fromSchema(schema)
  tmp.appendChild(serializer.serializeFragment(view.state.doc.content))
  const docHtml = tmp.innerHTML

  try {
    const zipBase64 = await invoke('export_bundle', { doc_text: docText, doc_html: docHtml })
    if (!zipBase64) { alert('Export failed: empty bundle'); return; }

    // Decode base64 → Blob → download
    const binary = atob(zipBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'humanproof-session.zip'
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    alert(`Export failed: ${e}`)
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

initUI()
const view = buildEditor()
wireToolbar(view)
startAutosave()
startKeystrokePoller()

document.getElementById('btn-export').addEventListener('click', () => handleExport(view))
```

- [ ] **Step 3: Verify frontend compiles with Vite**

```bash
cd /Users/dghosef/editor && npm run build 2>&1 | tail -15
```

Expected: build succeeds, `dist/` created.

- [ ] **Step 4: Commit**

```bash
cd /Users/dghosef/editor
git add src/
git commit -m "feat: ProseMirror editor with paste/focus event logging"
```

---

## Task 7: Ed25519 signing + macOS Keychain

**Files:**
- Modify: `src-tauri/src/signing.rs`

- [ ] **Step 1: Write tests first**

Replace `src-tauri/src/signing.rs` with:

```rust
use ed25519_dalek::{SigningKey, VerifyingKey, Signer, Verifier, Signature};
use rand::rngs::OsRng;
use security_framework::passwords::{get_generic_password, set_generic_password};
use std::fs;
use std::path::PathBuf;

const SERVICE: &str = "com.humanproof.app";
const ACCOUNT: &str = "ed25519-signing-key";

/// Load the signing key from Keychain, or generate and store a new one.
pub fn load_or_create_key() -> Result<SigningKey, String> {
    match get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => {
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| "Keychain key has wrong length".to_string())?;
            Ok(SigningKey::from_bytes(&arr))
        }
        Err(_) => {
            // Generate new key
            let key = SigningKey::generate(&mut OsRng);
            let bytes = key.to_bytes();
            set_generic_password(SERVICE, ACCOUNT, &bytes)
                .map_err(|e| format!("Failed to store key in Keychain: {e}"))?;
            // Write public key to disk
            write_public_key(key.verifying_key())?;
            Ok(key)
        }
    }
}

/// Write the verifying (public) key to ~/.config/humanproof/pubkey.hex
pub fn write_public_key(vk: VerifyingKey) -> Result<(), String> {
    let dir = pubkey_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("pubkey.hex");
    let hex_key = hex::encode(vk.to_bytes());
    fs::write(&path, &hex_key).map_err(|e| e.to_string())?;
    Ok(())
}

fn pubkey_dir() -> PathBuf {
    let mut p = dirs_next::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    p.push("humanproof");
    p
}

/// Sign `data` with the provided key. Returns raw 64-byte signature.
pub fn sign(key: &SigningKey, data: &[u8]) -> [u8; 64] {
    key.sign(data).to_bytes()
}

/// Verify a signature. `pubkey_bytes` is 32 raw bytes of the verifying key.
pub fn verify(pubkey_bytes: &[u8; 32], data: &[u8], sig_bytes: &[u8; 64]) -> bool {
    let vk = match VerifyingKey::from_bytes(pubkey_bytes) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let sig = Signature::from_bytes(sig_bytes);
    vk.verify(data, &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    #[test]
    fn test_sign_and_verify_roundtrip() {
        let key = test_key();
        let vk_bytes = key.verifying_key().to_bytes();
        let data = b"hello attestation";
        let sig = sign(&key, data);
        assert!(verify(&vk_bytes, data, &sig));
    }

    #[test]
    fn test_wrong_data_fails_verify() {
        let key = test_key();
        let vk_bytes = key.verifying_key().to_bytes();
        let sig = sign(&key, b"original");
        assert!(!verify(&vk_bytes, b"tampered", &sig));
    }

    #[test]
    fn test_wrong_key_fails_verify() {
        let key1 = test_key();
        let key2 = test_key();
        let vk2_bytes = key2.verifying_key().to_bytes();
        let sig = sign(&key1, b"data");
        assert!(!verify(&vk2_bytes, b"data", &sig));
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/dghosef/editor && cargo test --manifest-path src-tauri/Cargo.toml signing 2>&1 | tail -15
```

Expected: `test result: ok. 3 passed; 0 failed`

- [ ] **Step 3: Commit**

```bash
cd /Users/dghosef/editor
git add src-tauri/src/signing.rs
git commit -m "feat: Ed25519 signing with macOS Keychain storage"
```

---

## Task 8: Bundle builder

**Files:**
- Modify: `src-tauri/src/bundle.rs`

The bundle zip contains: `document.txt`, `document.rtf`, `keystroke-log.jsonl`, `session-meta.json`, `bundle.sig`. The signature covers SHA-256 of the four data files concatenated in alphabetical filename order.

- [ ] **Step 1: Write tests first**

Replace `src-tauri/src/bundle.rs` with:

```rust
use sha2::{Sha256, Digest};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use std::io::Write;
use chrono::Utc;
use serde_json::json;
use crate::signing::{load_or_create_key, sign};

pub struct BundleInput {
    pub session_id: String,
    pub session_nonce: String,
    pub start_wall_ns: u64,
    pub log_jsonl: String,
    pub keystroke_count: usize,
}

/// Compute SHA-256 of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

/// Build the content of `document.rtf` from plain text (basic RTF wrapper).
pub fn make_rtf(plain_text: &str) -> String {
    // Escape backslash and braces for RTF
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

/// Compute the signing digest: SHA-256 of SHA-256(file_contents) for each
/// file, concatenated in alphabetical filename order:
/// document.rtf → document.txt → keystroke-log.jsonl → session-meta.json
pub fn compute_digest(
    rtf: &[u8],
    txt: &[u8],
    log: &[u8],
    meta: &[u8],
) -> Vec<u8> {
    let mut h = Sha256::new();
    // Alphabetical order
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
    // Format: hex-encoded signature
    let sig_content = hex::encode(sig_bytes);

    // Build zip in memory
    let mut zip_buf: Vec<u8> = Vec::new();
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
    drop(zip);

    Ok(base64_encode(&zip_buf))
}

fn base64_encode(data: &[u8]) -> String {
    use std::io::Write;
    // Use standard base64 via the `base64` crate — add to Cargo.toml
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_hex_known() {
        // echo -n "abc" | sha256sum
        let result = sha256_hex(b"abc");
        assert_eq!(result, "ba7816bf8f01cfea414140de5dae2ec73b00361bbef0469f490f4187397c5ff");
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
}
```

- [ ] **Step 2: Add `base64` crate to Cargo.toml**

Add to `[dependencies]`:

```toml
base64 = "0.22"
```

- [ ] **Step 3: Run bundle tests**

```bash
cd /Users/dghosef/editor && cargo test --manifest-path src-tauri/Cargo.toml bundle 2>&1 | tail -15
```

Expected: `test result: ok. 6 passed; 0 failed`

- [ ] **Step 4: Run all tests**

```bash
cd /Users/dghosef/editor && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/dghosef/editor
git add src-tauri/
git commit -m "feat: bundle builder with zip assembly, SHA-256 digest, and Ed25519 signature"
```

---

## Task 9: Wire export command end-to-end + smoke test

**Files:**
- Modify: `src-tauri/src/commands.rs` (update `export_bundle` body)

The `export_bundle` command stub in Task 5 already has the right signature. The bundle module's `build_and_sign` is now real. Verify the wiring compiles and produces a zip.

- [ ] **Step 1: Verify `export_bundle` in commands.rs calls the real bundle function**

The `export_bundle` command already calls `bundle::build_and_sign(session, doc_text, doc_html)` — confirm the `BundleInput` fields match what `commands.rs` constructs:

In `commands.rs`, the `session` variable is:
```rust
bundle::BundleInput {
    session_id: s.session_id.clone(),
    session_nonce: s.session_nonce.clone(),
    start_wall_ns: s.start_wall_ns,
    log_jsonl: s.to_jsonl(),
    keystroke_count: s.keystroke_count(),
}
```

This matches `BundleInput` exactly. No changes needed.

- [ ] **Step 2: Full build**

```bash
cd /Users/dghosef/editor && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -20
```

Expected: no errors.

- [ ] **Step 3: Write integration test for bundle round-trip**

Add to `src-tauri/src/bundle.rs` inside the `#[cfg(test)]` block:

```rust
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

        // Parse as zip and verify expected files exist
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
```

- [ ] **Step 4: Run all tests including integration**

```bash
cd /Users/dghosef/editor && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -15
```

Expected: all pass (the integration test hits the real Keychain on macOS — it will create a Keychain entry on first run).

- [ ] **Step 5: Run the full app**

```bash
cd /Users/dghosef/editor && npm run tauri dev
```

Expected:
- App window opens with the ProseMirror editor
- macOS prompts for Input Monitoring permission (grant it)
- Typing in the editor populates the keystroke log (visible in status bar after 2s)
- Clicking "Export Bundle" downloads a zip containing all 5 files

- [ ] **Step 6: Final commit**

```bash
cd /Users/dghosef/editor
git add src-tauri/ src/ index.html package.json vite.config.js
git commit -m "feat: complete MVP — editor, IOHIDManager capture, and signed attestation bundle"
```

---

## Spec Coverage Check

| Spec requirement | Task |
|---|---|
| Tauri + Rust architecture | Task 1 |
| IOHIDManager keyboard capture (dedicated CFRunLoop thread) | Task 4 |
| KeyEvent with nanosecond timestamp, HID key code, flags | Tasks 2, 3 |
| Paste events logged (not blocked) | Task 5, 6 |
| Focus-loss events logged | Task 5, 6 |
| ProseMirror editor: bold, italic, H1, H2, undo/redo | Task 6 |
| Word count, timer, dark mode, auto-save every 30s | Task 6 |
| Session metadata (session_id, nonce, timestamps, keystroke count, doc hash) | Task 8 |
| Attestation bundle zip with 5 files | Task 8 |
| SHA-256 digest over all files in deterministic order | Task 8 |
| Ed25519 signing | Task 7 |
| Private key in macOS Keychain | Task 7 |
| Public key written to ~/.config/humanproof/pubkey.hex | Task 7 |
| Export downloads zip | Task 6, 9 |
| Future: SPI-only filtering | Architecture preserved in IOHIDManager setup |
