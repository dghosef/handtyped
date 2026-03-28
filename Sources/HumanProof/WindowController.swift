import AppKit
import WebKit

@MainActor
class WindowController: NSWindowController {
    private var webView: WKWebView!
    private var bridgeHandler: BridgeHandler!
    private var appMenu: AppMenu!

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "HumanProof"
        window.center()

        self.init(window: window)

        // Configure WKWebView
        let config = WKWebViewConfiguration()
        let userContentController = WKUserContentController()

        // Inject bridge helper script at document start
        let bridgeScript = """
        window.__bridgeResolve = (id, result) => {
          const p = window.__bridgePending?.get(id)
          if (p) { p.resolve(result); window.__bridgePending.delete(id) }
        }
        window.__bridgeReject = (id, error) => {
          const p = window.__bridgePending?.get(id)
          if (p) { p.reject(new Error(String(error))); window.__bridgePending.delete(id) }
        }
        """
        let userScript = WKUserScript(
            source: bridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        userContentController.addUserScript(userScript)

        // Create webView first, then handler with reference to it
        config.userContentController = userContentController
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.customUserAgent = "HumanProof/0.1 (macOS; WKWebView)"

        let handler = BridgeHandler(webView: wv)
        userContentController.add(handler, name: "__bridge")

        self.webView = wv
        self.bridgeHandler = handler
        HIDCapture.shared.webView = wv

        window.contentView = wv

        // Only allow keystrokes from the built-in keyboard.
        // - Synthetic events (osascript/CGEventPost) are rejected via eventSourceStateID != HIDSystemState.
        // - External keyboard events are rejected because IOHIDManager only increments
        //   pendingBuiltInKeyDowns for built-in keyboard events; external keyboards leave
        //   the counter at zero, so consumePendingBuiltInKeyDown() returns false.
        // - OS key-repeat events are allowed only when the held key was originally
        //   accepted (tracked via lastWasBuiltIn).
        var lastWasBuiltIn = false
        NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { event in
            // isARepeat is only valid on keyDown; correction-panel synthetic events
            // arrive as keyDown but may fail the assertion — guard defensively.
            if event.type == .keyDown && event.isARepeat { return lastWasBuiltIn ? event : nil }

            guard let cg = event.cgEvent else { return event }
            let stateID = cg.getIntegerValueField(.eventSourceStateID)
            guard stateID == CGEventSourceStateID.hidSystemState.rawValue else {
                lastWasBuiltIn = false
                return nil
            }

            // For flagsChanged (modifier keys) there is no text insertion so we
            // skip the HID counter check and just rely on the sourceStateID guard above.
            guard event.type == .keyDown else { return event }

            lastWasBuiltIn = HIDCapture.shared.consumePendingBuiltInKeyDown()
            return lastWasBuiltIn ? event : nil
        }

        // Set up native menu bar
        self.appMenu = AppMenu()
        self.appMenu.setup(webView: wv)

        // Load dev server
        if let url = URL(string: "http://localhost:5173") {
            wv.load(URLRequest(url: url))
        }
    }
}
