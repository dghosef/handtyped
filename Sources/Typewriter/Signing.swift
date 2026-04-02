import CryptoKit
import Security
import Foundation

class Signing {
    static let service = "com.handtyped.app"
    static let account = "ed25519-signing-key"

    static func loadOrCreateKey() throws -> Curve25519.Signing.PrivateKey {
        // Try to load from Keychain
        if let key = try? loadFromKeychain() {
            return key
        }
        // Generate new key
        let newKey = Curve25519.Signing.PrivateKey()
        try saveToKeychain(newKey)
        try writePubkeyHex(newKey.publicKey)
        return newKey
    }

    private static func loadFromKeychain() throws -> Curve25519.Signing.PrivateKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            if status == errSecItemNotFound { return nil }
            throw KeychainError.loadFailed(status)
        }
        return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }

    private static func saveToKeychain(_ key: Curve25519.Signing.PrivateKey) throws {
        let keyData = key.rawRepresentation
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: keyData,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        // Delete existing item first (if any)
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            throw KeychainError.saveFailed(status)
        }
    }

    private static func writePubkeyHex(_ publicKey: Curve25519.Signing.PublicKey) throws {
        let hexPubkey = publicKey.rawRepresentation
            .map { String(format: "%02x", $0) }
            .joined()

        let configDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/handtyped")
        try FileManager.default.createDirectory(
            at: configDir,
            withIntermediateDirectories: true
        )
        let pubkeyPath = configDir.appendingPathComponent("pubkey.hex")
        try hexPubkey.write(to: pubkeyPath, atomically: true, encoding: .utf8)
    }

    static func sign(key: Curve25519.Signing.PrivateKey, data: Data) throws -> Data {
        return try key.signature(for: data)
    }
}

enum KeychainError: Error, LocalizedError {
    case loadFailed(OSStatus)
    case saveFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .loadFailed(let s): return "Keychain load failed: \(s)"
        case .saveFailed(let s): return "Keychain save failed: \(s)"
        }
    }
}
