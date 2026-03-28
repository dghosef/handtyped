import Foundation
import IOKit
import IOKit.hid
import WebKit

@MainActor
class HIDCapture {
    static let shared = HIDCapture()

    private(set) var isActive = false
    let startWallNs: UInt64

    // Counts key-downs from the built-in keyboard that have fired via HID
    // but haven't yet been matched to an NSEvent. Consumed by WindowController's
    // local event monitor to gate which keystrokes reach the editor.
    private(set) var pendingBuiltInKeyDowns = 0
    private var karabinerWarned = false

    private var manager: IOHIDManager?
    private var retryTimer: Timer?

    // Set by WindowController after init.
    weak var webView: WKWebView?

    private init() {
        startWallNs = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
    }

    func requestAccess() {
        // kIOHIDRequestTypeListenEvent rawValue == 1
        let listenType = IOHIDRequestType(rawValue: 1)
        // kIOHIDAccessTypeGranted rawValue == 0
        let granted = IOHIDCheckAccess(listenType)
        if granted.rawValue != 0 {
            IOHIDRequestAccess(listenType)
        }
    }

    func start() {
        let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = mgr

        // Match all keyboards; built-in filtering is done per-event in handleHIDValue.
        let matchDict: [String: Any] = [
            kIOHIDDeviceUsagePageKey: kHIDPage_GenericDesktop,
            kIOHIDDeviceUsageKey: kHIDUsage_GD_Keyboard
        ]
        IOHIDManagerSetDeviceMatching(mgr, matchDict as CFDictionary)

        // Register input value callback using Unmanaged pattern
        let selfPtr = Unmanaged.passRetained(self).toOpaque()
        IOHIDManagerRegisterInputValueCallback(mgr, { ctx, _, _, value in
            guard let ctx else { return }
            let cap = Unmanaged<HIDCapture>.fromOpaque(ctx).takeUnretainedValue()
            cap.handleHIDValue(value)
        }, selfPtr)

        // Schedule on main run loop
        IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)

        let ret = IOHIDManagerOpen(mgr, IOOptionBits(kIOHIDOptionsTypeNone))
        if ret == kIOReturnSuccess {
            isActive = true
        } else {
            // Start retry timer
            retryTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] timer in
                guard let self else {
                    timer.invalidate()
                    return
                }
                // Must dispatch back to main actor for state mutation
                Task { @MainActor in
                    self.retryOpen(timer: timer)
                }
            }
        }
    }

    private func retryOpen(timer: Timer) {
        guard let mgr = manager else {
            timer.invalidate()
            return
        }
        let listenType = IOHIDRequestType(rawValue: 1)
        guard IOHIDCheckAccess(listenType).rawValue == 0 else { return }

        let ret = IOHIDManagerOpen(mgr, IOOptionBits(kIOHIDOptionsTypeNone))
        if ret == kIOReturnSuccess {
            isActive = true
            timer.invalidate()
            retryTimer = nil
            // Notify frontend via JS
            webView?.evaluateJavaScript(
                "window.__hidBecameActive && window.__hidBecameActive()",
                completionHandler: nil
            )
        }
    }

    // Called by WindowController's NSEvent monitor to verify a key-down
    // came from the built-in keyboard. Returns false if no pending built-in
    // key-down exists (external keyboard or synthetic event).
    func consumePendingBuiltInKeyDown() -> Bool {
        guard pendingBuiltInKeyDowns > 0 else { return false }
        pendingBuiltInKeyDowns -= 1
        return true
    }

    // Called from HID callback (on main run loop)
    func handleHIDValue(_ value: IOHIDValue) {
        let element = IOHIDValueGetElement(value)
        let usagePage = IOHIDElementGetUsagePage(element)
        guard usagePage == UInt32(kHIDPage_KeyboardOrKeypad) else { return }

        // Reject events from explicitly external devices.
        // Check the Transport property: USB and Bluetooth are always external.
        // If the property is missing or is something else (e.g. SPI, I2C), it's built-in.
        let device = IOHIDElementGetDevice(element)
        let service = IOHIDDeviceGetService(device)
        // Only accept events from SPI keyboards (built-in keyboard on Apple Silicon Macs).
        // If the transport property is missing or is anything other than "SPI", reject.
        guard let transportRef = IORegistryEntryCreateCFProperty(
            service, kIOHIDTransportKey as CFString, kCFAllocatorDefault, 0
        ) else {
            // No transport property — likely a virtual HID device (e.g. Karabiner-Elements).
            // Warn the user once if it looks like Karabiner.
            if !karabinerWarned,
               let productRef = IORegistryEntryCreateCFProperty(
                   service, kIOHIDProductKey as CFString, kCFAllocatorDefault, 0
               ),
               let product = productRef.takeRetainedValue() as? String,
               product.lowercased().contains("karabiner") {
                karabinerWarned = true
                webView?.evaluateJavaScript(
                    "window.__karabinerDetected && window.__karabinerDetected()",
                    completionHandler: nil
                )
            }
            return
        }
        guard (transportRef.takeRetainedValue() as? String) == "SPI" else { return }

        let usage = IOHIDElementGetUsage(element)
        guard usage != 0 else { return }
        let intVal = IOHIDValueGetIntegerValue(value)

        if intVal != 0 { pendingBuiltInKeyDowns += 1 }

        let kind: String = intVal != 0 ? "keydown" : "keyup"
        let t = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
        Session.shared.appendKey(t: t, kind: kind, key: usage, flags: 0)
    }
}

