# HumanProof — Manual TODO

Things that require human judgment, physical hardware, or real-world testing.

---

## Hardware / Platform Testing

- [ ] **Verify built-in keyboard works on Intel Macs** — SPI transport is Apple Silicon only. Intel MacBooks used a USB-connected internal keyboard. Need to check what transport string appears there (likely `"USB"` with a fixed location ID, or possibly `"I2C"`). May need to add a fallback transport value or use a different identifier.

- [ ] **Verify external USB keyboard is blocked** — Connect a USB keyboard and confirm keystrokes do not appear in the editor.

- [ ] **Verify external Bluetooth keyboard is blocked** — Pair a Bluetooth keyboard and confirm keystrokes do not appear in the editor.

- [ ] **Verify osascript injection is blocked** — Run `osascript -e 'tell application "System Events" to keystroke "a"'` while the editor is focused and confirm nothing appears.

- [ ] **Verify paste is blocked** — Try Cmd+V, right-click → Paste, and drag-and-drop text. None should insert into the editor.

---

## Distribution / Signing

- [ ] **Get Apple Developer ID certificate** ($99/year) — Required for notarization and Gatekeeper. Self-signed cert ("HumanProof Dev") only works on your own machine.

- [ ] **Notarize the app** — Required for distribution on macOS 10.15+. Enables TCC grants to persist across app updates when signed with Developer ID.

---

## Known Compatibility Issues

- [ ] **Karabiner-Elements conflict** — Karabiner intercepts SPI keyboard events and re-emits them via a virtual HID keyboard with no Transport property. HumanProof's SPI filter blocks these. Users with Karabiner must add HumanProof to Karabiner's "Excluded Applications" list (Karabiner-Elements → Misc → Excluded applications). This is intentional: Karabiner can inject arbitrary keystrokes, so allowing it would undermine attestation.

---

## Design Decisions Requiring Human Judgment

- [ ] **What to do on Intel Macs** — Decide whether to support Intel Macs (requires different transport filter) or document Apple Silicon only.

- [ ] **Dictation policy** — macOS Dictation fires real keyboard-like events and currently passes the SPI filter. Decide whether to allow or block dictation input (blocking it fully may require CGEvent tap + Accessibility permission, adding another permission request).
