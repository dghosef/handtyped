import Foundation
import WebKit

@MainActor
class BridgeHandler: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    init(webView: WKWebView) {
        self.webView = webView
    }

    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // message.body is main-actor isolated; extract it via MainActor.assumeIsolated
        // since WKScriptMessage delegates are always delivered on the main thread.
        let body = MainActor.assumeIsolated { message.body }
        guard let dict = body as? [String: Any],
              let id = dict["id"] as? Int,
              let command = dict["command"] as? String
        else { return }

        let args = dict["args"] as? [String: Any] ?? [:]

        Task { @MainActor in
            do {
                let result = try await self.handleCommand(command, args: args)
                if result == "null" {
                    self.webView?.evaluateJavaScript("window.__bridgeResolve(\(id), null)", completionHandler: nil)
                } else {
                    self.webView?.evaluateJavaScript("window.__bridgeResolve(\(id), \(result))", completionHandler: nil)
                }
            } catch {
                let msg = error.localizedDescription.replacingOccurrences(of: "'", with: "\\'")
                self.webView?.evaluateJavaScript("window.__bridgeReject(\(id), '\(msg)')", completionHandler: nil)
            }
        }
    }

    func handleCommand(_ command: String, args: [String: Any]) async throws -> String {
        switch command {
        case "log_paste_event":
            let charCount = args["char_count"] as? Int
            let t = currentNs()
            Session.shared.appendExtra(t: t, kind: "paste", charCount: charCount)
            return "null"

        case "log_focus_loss_event":
            let durationMs = args["duration_ms"] as? Int
            let t = currentNs()
            Session.shared.appendExtra(t: t, kind: "focus_loss", durationMs: durationMs.map { UInt64($0) })
            return "null"

        case "get_keystroke_count":
            return "\(Session.shared.keystrokeCount)"

        case "get_hid_status":
            return HIDCapture.shared.isActive ? "true" : "false"

        case "open_input_monitoring_settings":
            let urlStr = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            if let url = URL(string: urlStr) {
                NSWorkspace.shared.open(url)
            }
            return "null"

        case "save_session":
            try Session.shared.saveToDisk()
            return "null"

        case "export_bundle":
            let docText = args["doc_text"] as? String ?? ""
            let docHtml = args["doc_html"] as? String ?? ""
            let base64 = try await BundleExport.build(docText: docText, docHtml: docHtml)
            // Encode as JSON string
            let encoded = try JSONEncoder().encode(base64)
            return String(data: encoded, encoding: .utf8)!

        default:
            throw BridgeError.unknownCommand(command)
        }
    }

    private func currentNs() -> UInt64 {
        UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
    }
}

enum BridgeError: Error, LocalizedError {
    case unknownCommand(String)

    var errorDescription: String? {
        switch self {
        case .unknownCommand(let cmd):
            return "Unknown bridge command: \(cmd)"
        }
    }
}
