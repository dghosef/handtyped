# Keystroke Attestation Word Processor — Design Spec

> Historical note: this spec describes the original Tauri + WebView + ProseMirror design. The current product direction is a Rust-native markdown editor centered on `src-tauri/src/bin/humanproof_native.rs`. Treat the details below as legacy architecture history, not the current target state.

**Date:** 2026-03-26
**Status:** Approved
**MVP Scope:** Editor + keystroke log + attestation bundle (no classifier, no verification tool)

---

## 1. Stack

- **Framework:** Tauri (Rust backend + WebView frontend)
- **Editor:** ProseMirror (adapted from prior implementation in git history)
- **Keystroke capture:** IOHIDManager via Rust FFI to IOKit
- **Signing:** Ed25519 via `ed25519-dalek`; private key in macOS Keychain via `security-framework`
- **Bundle format:** `.zip`

---

## 2. Architecture

```
┌─────────────────────────────────────────────┐
│  Tauri App                                   │
│                                              │
│  ┌──────────────────┐   ┌─────────────────┐ │
│  │  WebView          │   │  Rust Backend   │ │
│  │  ProseMirror      │   │                 │ │
│  │  editor           │   │  IOHIDManager   │ │
│  │                   │   │  (dedicated     │ │
│  │  paste/focus      │──▶│   CFRunLoop     │ │
│  │  events via       │   │   thread)       │ │
│  │  Tauri commands   │   │  ↓              │ │
│  └──────────────────┘   │  Keystroke Log  │ │
│                          │  Mutex<Vec>     │ │
│                          │  ↓              │ │
│                          │  Bundle Builder │ │
│                          │  (on export)    │ │
│                          └─────────────────┘ │
└─────────────────────────────────────────────┘
```

---

## 3. Input Capture — IOHIDManager

- Rust backend opens an `IOHIDManager` and registers a callback for all keyboard HID devices.
- The manager runs on a dedicated thread with its own `CFRunLoop` (never blocks the UI thread).
- Each callback fires with an `IOHIDValue` providing:
  - HID usage page + usage code (key identity)
  - `IOHIDValueGetTimeStamp` → absolute time in nanoseconds, converted to wall-clock ns
  - Integer value (1 = down, 0 = up)
  - Modifier flags
- Requires **Input Monitoring** permission (macOS 10.15+). App prompts on first launch; refuses to log if permission is denied.

**Future upgrade path:** Add device matching on `kIOHIDTransportKey = "SPI"` + Apple vendor/product IDs to restrict to internal keyboard only. No structural changes needed.

---

## 4. Keystroke Log

**In-memory:** `Mutex<Vec<KeyEvent>>` held in Tauri state.
**On-disk:** Flushed to `session-<uuid>/keystroke-log.jsonl` every 30 seconds and on export.

Each keyboard event:
```json
{"t": 1719283847123456789, "type": "down", "key": 4, "flags": 0}
{"t": 1719283847198765432, "type": "up",   "key": 4, "flags": 0}
```

- `t` — wall-clock nanoseconds
- `type` — `"down"` | `"up"`
- `key` — HID usage code (keyboard/keypad usage page 0x07)
- `flags` — modifier bitmask (shift, ctrl, option, cmd)

Additional events from webview (logged, not blocked):
```json
{"t": ..., "type": "paste",      "char_count": 142}
{"t": ..., "type": "focus_loss", "duration_ms": 4200}
```

---

## 5. Editor (WebView)

ProseMirror with:
- Bold, italic, H1, H2, paragraphs
- Word count + character count
- Undo/redo (ProseMirror history plugin)
- Session timer (elapsed, visible)
- Light/dark mode toggle
- Auto-save every 30s (Tauri command → Rust writes to disk)
- Export button → triggers bundle builder

Explicitly excluded: spell check, grammar, network access, images, tables, code blocks.

Paste events are logged (not blocked). `paste` DOM event fires a Tauri command recording timestamp + character count of clipboard content. Focus-loss events (`visibilitychange`, window blur) similarly logged.

---

## 6. Session Metadata

Written at export time as `session-meta.json`:

```json
{
  "session_id": "<uuidv4>",
  "session_nonce": "<256-bit random hex>",
  "app_version": "0.1.0",
  "session_start": "2026-03-26T14:00:00Z",
  "session_end": "2026-03-26T15:30:00Z",
  "total_keystrokes": 4821,
  "document_content_hash": "<sha256 hex of document.txt>"
}
```

---

## 7. Attestation Bundle

Export produces a `.zip` named `session-<uuid>.zip`:

```
session-<uuid>/
  document.txt
  document.rtf
  keystroke-log.jsonl
  session-meta.json
  bundle.sig
```

**Signing:**
- Ed25519 keypair generated on first app launch.
- Private key stored in macOS Keychain via `security-framework`.
- Public key written to `~/.config/humanproof/pubkey.pem` (shareable with verifiers).
- `bundle.sig` is a detached Ed25519 signature over the SHA-256 of each file's contents, concatenated in deterministic alphabetical filename order:
  `document.rtf → document.txt → keystroke-log.jsonl → session-meta.json`

**Future upgrade:** Private key moves to Secure Enclave; `session-meta.json` gains SIP/VM/code-signature fields. Bundle format unchanged.

---

## 8. Deferred (v2+)

- SPI-only HID filtering
- Keystroke dynamics classifier
- Verification CLI/tool
- Code signing + notarization (requires Apple Developer account)
- Secure Enclave key storage
- SIP/VM integrity checks
