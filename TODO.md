# Handtyped TODO

# Software features
- Heatmap of heavily edited text vs non. Take into account type edits vs big edits
- syntax highlighting
- Embed button
- Replay should allow you to pick between realtime or give each character constant time.
## Hardware / Platform Testing

- [ ] **Verify the native Rust editor only accepts built-in keyboard input** — Grant Input Monitoring to `~/Applications/Handtyped.app`, type from the internal keyboard, then confirm non-built-in input paths are reverted/blocked.

- [ ] **Verify external USB keyboard is blocked** — Connect a USB keyboard and confirm keystrokes do not appear in the editor.

- [ ] **Verify external Bluetooth keyboard is blocked** — Pair a Bluetooth keyboard and confirm keystrokes do not appear in the editor.

- [ ] **Verify osascript injection is blocked** — Run `osascript -e 'tell application "System Events" to keystroke "a"'` while the editor is focused and confirm nothing appears.

- [ ] **Verify paste is blocked** — Try Cmd+V, right-click → Paste, and drag-and-drop text. None should insert into the editor.

- [ ] **Test on multiple Apple Silicon Macs** — Confirm the built-in keyboard / SPI path behaves consistently across Apple Silicon hardware.
---

## Distribution / Signing

- [ ] **Get Apple Developer ID certificate** ($99/year) — Required for notarization and Gatekeeper. Self-signed cert ("Handtyped Dev") only works on your own machine.

- [ ] **Notarize the app** — Required for distribution on macOS 10.15+. Enables TCC grants to persist across app updates when signed with Developer ID.

---

## Known Compatibility Issues

- [ ] **Karabiner-Elements is unsupported** — Karabiner intercepts SPI keyboard events and re-emits them via a virtual HID keyboard with no Transport property. Handtyped intentionally blocks these events because allowing them would undermine attestation.

---

## Product Policy

- **Apple Silicon only** — Intel Mac support is not planned.
- **Dictation is unsupported** — macOS Dictation can look like real keyboard input and is not part of the attested input model.
