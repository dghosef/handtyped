use ed25519_dalek::{SigningKey, VerifyingKey, Signer, Verifier, Signature};
use rand::rngs::OsRng;
use security_framework::passwords::{get_generic_password, set_generic_password};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;
use std::fs;
use std::path::PathBuf;

const SERVICE: &str = "com.humanproof.app";
const ACCOUNT: &str = "ed25519-signing-key";

/// Load the signing key from Keychain, or generate and store a new one.
/// Raw key bytes are wrapped in Zeroizing so they are wiped from memory on drop.
pub fn load_or_create_key() -> Result<SigningKey, String> {
    match get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => {
            let raw: Zeroizing<[u8; 32]> = Zeroizing::new(
                bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| "Keychain key has wrong length".to_string())?,
            );
            let key = SigningKey::from_bytes(&*raw);
            // Restore pubkey.hex if it was deleted
            let _ = write_public_key(key.verifying_key());
            Ok(key)
        }
        Err(_) => {
            let key = SigningKey::generate(&mut OsRng);
            let raw: Zeroizing<[u8; 32]> = Zeroizing::new(key.to_bytes());
            set_generic_password(SERVICE, ACCOUNT, &*raw)
                .map_err(|e| format!("Failed to store key in Keychain: {e}"))?;
            write_public_key(key.verifying_key())?;
            Ok(key)
        }
    }
}

/// Derive a stable 32-byte document-store key from the long-lived signing key.
/// This lets the app keep local autosave data encrypted without introducing a
/// second independently-managed secret in Keychain.
pub fn derive_document_store_key() -> Result<[u8; 32], String> {
    let signing_key = load_or_create_key()?;
    Ok(derive_document_store_key_from_seed(&signing_key.to_bytes()))
}

fn derive_document_store_key_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"humanproof-docstore-v1");
    h.update(seed);
    h.finalize().into()
}

/// Write the verifying (public) key as hex to ~/.config/humanproof/pubkey.hex
pub fn write_public_key(vk: VerifyingKey) -> Result<(), String> {
    let dir = pubkey_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("pubkey.hex");
    let hex_key = hex::encode(vk.to_bytes());
    fs::write(&path, &hex_key).map_err(|e| e.to_string())
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

    #[test]
    fn test_document_store_key_derivation_is_deterministic() {
        let seed = [7u8; 32];
        let key1 = derive_document_store_key_from_seed(&seed);
        let key2 = derive_document_store_key_from_seed(&seed);
        assert_eq!(key1, key2);
        assert_eq!(key1.len(), 32);
    }

    #[test]
    fn test_document_store_key_derivation_is_domain_separated() {
        let seed1 = [1u8; 32];
        let seed2 = [2u8; 32];
        assert_ne!(
            derive_document_store_key_from_seed(&seed1),
            derive_document_store_key_from_seed(&seed2)
        );
    }
}
