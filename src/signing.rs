use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use security_framework::passwords::{get_generic_password, set_generic_password};
use sha2::{Digest, Sha256};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use zeroize::Zeroizing;

const SERVICE: &str = "com.handtyped.app";
const LEGACY_SERVICE: &str = "com.typewriter.app";
const ACCOUNT: &str = "ed25519-signing-key";
static KEY_CACHE: OnceLock<[u8; 32]> = OnceLock::new();

fn config_dir() -> PathBuf {
    let mut p = dirs_next::config_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    p.push("handtyped");
    p
}

fn private_key_path() -> PathBuf {
    config_dir().join("signing-key.hex")
}

fn decode_signing_key_bytes(bytes: &[u8]) -> Result<[u8; 32], String> {
    bytes
        .try_into()
        .map_err(|_| "Signing key has wrong length".to_string())
}

fn decode_signing_key_hex(value: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(value.trim()).map_err(|e| e.to_string())?;
    decode_signing_key_bytes(&bytes)
}

fn load_key_from_mirror_file() -> Result<Option<SigningKey>, String> {
    let path = private_key_path();
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let key_bytes = decode_signing_key_hex(&raw)?;
    Ok(Some(SigningKey::from_bytes(&key_bytes)))
}

fn write_key_mirror(key: &SigningKey) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = private_key_path();
    fs::write(&path, hex::encode(key.to_bytes())).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn create_and_store_local_key() -> Result<SigningKey, String> {
    let key = SigningKey::generate(&mut OsRng);
    write_key_mirror(&key)?;
    let _ = KEY_CACHE.set(key.to_bytes());
    write_public_key(key.verifying_key())?;
    mirror_key_to_keychain_in_background(key.to_bytes());
    Ok(key)
}

fn mirror_key_to_keychain_in_background(key_bytes: [u8; 32]) {
    thread::spawn(move || {
        let raw: Zeroizing<[u8; 32]> = Zeroizing::new(key_bytes);
        let _ = set_generic_password(SERVICE, ACCOUNT, &*raw);
    });
}

/// Load the signing key from Keychain, or generate and store a new one.
/// Raw key bytes are wrapped in Zeroizing so they are wiped from memory on drop.
pub fn load_or_create_key() -> Result<SigningKey, String> {
    if let Some(cached) = KEY_CACHE.get() {
        return Ok(SigningKey::from_bytes(cached));
    }

    if let Some(key) = load_key_from_mirror_file()? {
        let _ = KEY_CACHE.set(key.to_bytes());
        let _ = write_public_key(key.verifying_key());
        return Ok(key);
    }

    match get_generic_password(SERVICE, ACCOUNT)
        .or_else(|_| get_generic_password(LEGACY_SERVICE, ACCOUNT))
    {
        Ok(bytes) => {
            let raw: Zeroizing<[u8; 32]> =
                Zeroizing::new(decode_signing_key_bytes(bytes.as_slice())?);
            let key = SigningKey::from_bytes(&*raw);
            let _ = KEY_CACHE.set(key.to_bytes());
            let _ = write_key_mirror(&key);
            let _ = write_public_key(key.verifying_key());
            Ok(key)
        }
        Err(_) => {
            create_and_store_local_key()
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

/// Kick off a best-effort background warmup so the first action that truly
/// needs signing is less likely to block on Keychain initialization.
pub fn prime_key_cache_in_background() {
    if KEY_CACHE.get().is_some() {
        return;
    }
    thread::spawn(|| {
        let _ = load_or_create_key();
    });
}

pub fn load_or_create_key_with_timeout(timeout: Duration) -> Result<SigningKey, String> {
    if let Some(cached) = KEY_CACHE.get() {
        return Ok(SigningKey::from_bytes(cached));
    }

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(load_or_create_key());
    });

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if let Some(key) = load_key_from_mirror_file()? {
                let _ = KEY_CACHE.set(key.to_bytes());
                let _ = write_public_key(key.verifying_key());
                Ok(key)
            } else {
                create_and_store_local_key()
            }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Signing key initialization failed".to_string())
        }
    }
}

fn derive_document_store_key_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"handtyped-docstore-v1");
    h.update(seed);
    h.finalize().into()
}

/// Write the verifying (public) key as hex to ~/.config/handtyped/pubkey.hex
pub fn write_public_key(vk: VerifyingKey) -> Result<(), String> {
    let dir = pubkey_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("pubkey.hex");
    let hex_key = hex::encode(vk.to_bytes());
    fs::write(&path, &hex_key).map_err(|e| e.to_string())
}

fn pubkey_dir() -> PathBuf {
    config_dir()
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
