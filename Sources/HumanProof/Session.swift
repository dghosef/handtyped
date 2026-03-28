import Foundation
import CryptoKit

struct KeyEvent: Encodable {
    let t: UInt64
    let type: String
    let key: UInt32
    let flags: UInt32
}

struct ExtraEvent: Encodable {
    let t: UInt64
    let type: String
    let char_count: Int?
    let duration_ms: UInt64?

    init(t: UInt64, type: String, charCount: Int? = nil, durationMs: UInt64? = nil) {
        self.t = t
        self.type = type
        self.char_count = charCount
        self.duration_ms = durationMs
    }
}

@MainActor
class Session {
    static let shared = Session()

    let sessionId = UUID().uuidString
    let sessionNonce: String
    let startWallNs: UInt64

    private var keyEvents: [KeyEvent] = []
    // Combined ordered log stored as JSON strings for efficient JSONL serialization
    private var orderedLog: [String] = []

    var keystrokeCount: Int { keyEvents.count }

    private init() {
        startWallNs = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
        var nonceBytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &nonceBytes)
        sessionNonce = nonceBytes.map { String(format: "%02x", $0) }.joined()
    }

    func appendKey(t: UInt64, kind: String, key: UInt32, flags: UInt32) {
        let event = KeyEvent(t: t, type: kind, key: key, flags: flags)
        keyEvents.append(event)
        if let data = try? JSONEncoder().encode(event),
           let jsonStr = String(data: data, encoding: .utf8) {
            orderedLog.append(jsonStr)
        }
    }

    func appendExtra(t: UInt64, kind: String, charCount: Int? = nil, durationMs: UInt64? = nil) {
        let event = ExtraEvent(t: t, type: kind, charCount: charCount, durationMs: durationMs)
        if let data = try? JSONEncoder().encode(event),
           let jsonStr = String(data: data, encoding: .utf8) {
            orderedLog.append(jsonStr)
        }
    }

    // Returns JSONL string of ALL events in insertion order
    func toJSONL() -> String {
        orderedLog.joined(separator: "\n")
    }

    func saveToDisk() throws {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("humanproof/sessions/\(sessionId)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let logPath = dir.appendingPathComponent("keystroke-log.jsonl")
        try toJSONL().write(to: logPath, atomically: true, encoding: .utf8)
    }
}
