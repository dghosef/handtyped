import Foundation
import CryptoKit

class BundleExport {

    static func build(docText: String, docHtml: String) async throws -> String {
        let session = await Session.shared

        let sessionId = await session.sessionId
        let sessionNonce = await session.sessionNonce
        let startWallNs = await session.startWallNs
        let keystrokeCount = await session.keystrokeCount
        let jsonl = await session.toJSONL()

        // 1. Build file contents
        let docTextData = Data(docText.utf8)
        let rtfString = makeRTF(docText)
        let rtfData = Data(rtfString.utf8)
        let jsonlData = Data(jsonl.utf8)

        // Compute doc sha256 for meta
        let docSha256 = sha256Hex(docTextData)

        // session-meta.json
        let meta: [String: Any] = [
            "session_id": sessionId,
            "session_nonce": sessionNonce,
            "start_wall_ns": startWallNs,
            "keystroke_count": keystrokeCount,
            "doc_sha256": docSha256,
            "bundle_version": "1"
        ]
        let metaData = try JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted, .sortedKeys])

        // 2. Compute SHA-256 hex of each file
        let files: [(name: String, data: Data)] = [
            ("doc.txt", docTextData),
            ("doc.rtf", rtfData),
            ("keystroke-log.jsonl", jsonlData),
            ("session-meta.json", metaData)
        ]

        let fileHashes = files.map { (name: $0.name, hash: sha256Hex($0.data)) }

        // 3. Compute digest = SHA-256 of sorted (by filename) hashes concatenated
        let sortedHashes = fileHashes.sorted { $0.name < $1.name }
        let digestInput = sortedHashes.map { $0.hash }.joined()
        let digestData = Data(digestInput.utf8)
        let digestHashData = Data(SHA256.hash(data: digestData))

        // 4. Load/create Ed25519 key, sign digest
        let signingKey = try Signing.loadOrCreateKey()
        let signature = try Signing.sign(key: signingKey, data: digestHashData)
        let sigHex = signature.map { String(format: "%02x", $0) }.joined()
        let sigData = Data(sigHex.utf8)

        // 5. Create zip in temp dir with prefix session-<uuid>/
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("handtyped-export-\(UUID().uuidString)")
        let sessionPrefix = "session-\(sessionId)"
        let sessionDir = tmpDir.appendingPathComponent(sessionPrefix)
        try FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)

        // Write all files into sessionDir
        var allFiles = files
        allFiles.append(("bundle.sig", sigData))
        for file in allFiles {
            try file.data.write(to: sessionDir.appendingPathComponent(file.name))
        }

        // Create zip
        let zipPath = tmpDir.appendingPathComponent("bundle.zip")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        process.arguments = [
            "-j",
            zipPath.path,
            sessionDir.appendingPathComponent("doc.txt").path,
            sessionDir.appendingPathComponent("doc.rtf").path,
            sessionDir.appendingPathComponent("keystroke-log.jsonl").path,
            sessionDir.appendingPathComponent("session-meta.json").path,
            sessionDir.appendingPathComponent("bundle.sig").path
        ]
        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw BundleExportError.zipFailed(process.terminationStatus)
        }

        // 6. Return base64 of zip
        let zipData = try Data(contentsOf: zipPath)
        let base64 = zipData.base64EncodedString()

        // Clean up temp dir
        try? FileManager.default.removeItem(at: tmpDir)

        return base64
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func makeRTF(_ text: String) -> String {
        let escaped = text
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "{", with: "\\{")
            .replacingOccurrences(of: "}", with: "\\}")
        return "{\\rtf1\\ansi\\deff0 \\pard \(escaped)}"
    }
}

enum BundleExportError: Error, LocalizedError {
    case zipFailed(Int32)

    var errorDescription: String? {
        switch self {
        case .zipFailed(let code): return "zip process failed with exit code \(code)"
        }
    }
}
