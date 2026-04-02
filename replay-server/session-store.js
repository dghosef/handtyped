import { isTrustedSigner } from './trusted-signers.js'

const REPLAY_ATTESTATION_FORMAT = 'handtyped-replay-attestation-v1'
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

const MAX_PAYLOAD_JSON_BYTES = 5 * 1024 * 1024
const MAX_DOC_TEXT_BYTES = 1 * 1024 * 1024
const MAX_DOC_HTML_BYTES = 1 * 1024 * 1024
const MAX_KEYSTROKE_LOG_BYTES = 4 * 1024 * 1024
const MAX_DOC_HISTORY_ENTRIES = 50_000

function newId() {
  return globalThis.crypto.randomUUID()
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength
}

function decodeHex(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0) {
    throw new Error(`Invalid ${label}`)
  }

  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < value.length; i += 2) {
    const byte = Number.parseInt(value.slice(i, i + 2), 16)
    if (!Number.isFinite(byte)) {
      throw new Error(`Invalid ${label}`)
    }
    bytes[i / 2] = byte
  }
  return bytes
}

function requireString(payload, key, { maxBytes, allowEmpty = true } = {}) {
  const value = payload[key]
  if (typeof value !== 'string') {
    throw new Error(`Expected string field "${key}"`)
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Field "${key}" must not be empty`)
  }
  if (maxBytes && utf8ByteLength(value) > maxBytes) {
    throw new Error(`Field "${key}" exceeds size limit`)
  }
  return value
}

function optionalString(payload, key, { maxBytes } = {}) {
  const value = payload[key]
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected string field "${key}"`)
  }
  if (maxBytes && utf8ByteLength(value) > maxBytes) {
    throw new Error(`Field "${key}" exceeds size limit`)
  }
  return value
}

function requireBoolean(payload, key) {
  const value = payload[key]
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean field "${key}"`)
  }
  return value
}

function requireFiniteNumber(payload, key) {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected numeric field "${key}"`)
  }
  return value
}

function requireArray(payload, key, { maxLength } = {}) {
  const value = payload[key]
  if (!Array.isArray(value)) {
    throw new Error(`Expected array field "${key}"`)
  }
  if (maxLength && value.length > maxLength) {
    throw new Error(`Field "${key}" exceeds size limit`)
  }
  return value
}

function buildEd25519Spki(rawPublicKey) {
  if (!(rawPublicKey instanceof Uint8Array) || rawPublicKey.length !== 32) {
    throw new Error('Invalid signer public key length')
  }
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + rawPublicKey.length)
  spki.set(ED25519_SPKI_PREFIX, 0)
  spki.set(rawPublicKey, ED25519_SPKI_PREFIX.length)
  return spki
}

async function verifyEd25519Signature(publicKeyHex, signatureHex, payloadJson) {
  const publicKeyRaw = decodeHex(publicKeyHex, 'signer public key')
  const signature = decodeHex(signatureHex, 'signature')
  const spki = buildEd25519Spki(publicKeyRaw)
  const key = await globalThis.crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )

  return globalThis.crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    signature,
    new TextEncoder().encode(payloadJson),
  )
}

function normalizeVerifiedPayload(payload) {
  const session_id = requireString(payload, 'session_id', { maxBytes: 256, allowEmpty: false })
  const session_nonce = requireString(payload, 'session_nonce', {
    maxBytes: 256,
    allowEmpty: false,
  })
  const doc_text = requireString(payload, 'doc_text', { maxBytes: MAX_DOC_TEXT_BYTES })
  const doc_html = requireString(payload, 'doc_html', { maxBytes: MAX_DOC_HTML_BYTES })
  const doc_history = requireArray(payload, 'doc_history', { maxLength: MAX_DOC_HISTORY_ENTRIES })
  const keystroke_log = requireString(payload, 'keystroke_log', {
    maxBytes: MAX_KEYSTROKE_LOG_BYTES,
  })
  const keystroke_count = requireFiniteNumber(payload, 'keystroke_count')
  const start_wall_ns = requireFiniteNumber(payload, 'start_wall_ns')
  const log_chain_hash = requireString(payload, 'log_chain_hash', { maxBytes: 256 })
  const app_binary_hash = requireString(payload, 'app_binary_hash', { maxBytes: 256 })
  const code_signing_valid = requireBoolean(payload, 'code_signing_valid')
  const os_version = requireString(payload, 'os_version', { maxBytes: 256 })
  const hardware_model = requireString(payload, 'hardware_model', { maxBytes: 256 })
  const hardware_uuid = requireString(payload, 'hardware_uuid', { maxBytes: 256 })
  const sip_enabled = requireBoolean(payload, 'sip_enabled')
  const vm_detected = requireBoolean(payload, 'vm_detected')
  const frida_detected = requireBoolean(payload, 'frida_detected')
  const dylib_injection_detected = requireBoolean(payload, 'dylib_injection_detected')
  const dyld_env_injection = requireBoolean(payload, 'dyld_env_injection')
  const keyboard_vendor_id = optionalString(payload, 'keyboard_vendor_id', { maxBytes: 32 })
  const keyboard_product_id = optionalString(payload, 'keyboard_product_id', { maxBytes: 32 })
  const keyboard_transport = optionalString(payload, 'keyboard_transport', { maxBytes: 32 })
  const recorded_timezone = requireString(payload, 'recorded_timezone', { maxBytes: 64 })
  const recorded_timezone_offset_minutes = requireFiniteNumber(
    payload,
    'recorded_timezone_offset_minutes',
  )

  if (keyboard_transport !== 'SPI') {
    throw new Error('Replay uploads require SPI keyboard transport')
  }
  if (frida_detected || dylib_injection_detected || dyld_env_injection) {
    throw new Error('Replay uploads rejected due to runtime tampering indicators')
  }

  return {
    session_id,
    session_nonce,
    doc_text,
    doc_html,
    doc_history,
    keystroke_log,
    keystroke_count,
    start_wall_ns,
    log_chain_hash,
    app_binary_hash,
    code_signing_valid,
    os_version,
    hardware_model,
    hardware_uuid,
    sip_enabled,
    vm_detected,
    frida_detected,
    dylib_injection_detected,
    dyld_env_injection,
    keyboard_vendor_id,
    keyboard_product_id,
    keyboard_transport,
    recorded_timezone,
    recorded_timezone_offset_minutes,
  }
}

export async function verifyAndNormalizeSession(
  envelope = {},
  {
    id = newId(),
    now = new Date().toISOString(),
    trustedSignerAllowlist = new Set(),
  } = {},
) {
  const parsed = await parseReplayAttestation(envelope)
  if (!(trustedSignerAllowlist instanceof Set) || trustedSignerAllowlist.size === 0) {
    throw new Error('No trusted Handtyped public keys are configured')
  }
  if (!isTrustedSigner(trustedSignerAllowlist, parsed.signerPubkeyHex)) {
    throw new Error('Untrusted Handtyped signer public key')
  }

  return {
    id,
    created_at: now,
    ...parsed.normalizedPayload,
    verification: {
      verified: true,
      verified_at: now,
      version: envelope.version,
      format: envelope.format,
      signer_pubkey_hex: parsed.signerPubkeyHex,
      signature_hex: envelope.signature_hex,
    },
  }
}

export async function parseReplayAttestation(envelope = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Replay upload must be an object')
  }
  if (envelope.version !== 1) {
    throw new Error('Unsupported replay attestation version')
  }
  if (envelope.format !== REPLAY_ATTESTATION_FORMAT) {
    throw new Error('Unsupported replay attestation format')
  }

  const payloadJson = requireString(envelope, 'payload_json', {
    maxBytes: MAX_PAYLOAD_JSON_BYTES,
    allowEmpty: false,
  })
  const signerPubkeyHex = requireString(envelope, 'signer_pubkey_hex', {
    maxBytes: 128,
    allowEmpty: false,
  })
  const signatureHex = requireString(envelope, 'signature_hex', {
    maxBytes: 256,
    allowEmpty: false,
  })

  let payload
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('Invalid replay attestation payload JSON')
  }

  const signatureValid = await verifyEd25519Signature(signerPubkeyHex, signatureHex, payloadJson)
  if (!signatureValid) {
    throw new Error('Replay attestation signature verification failed')
  }

  const normalizedPayload = normalizeVerifiedPayload(payload)

  return {
    signerPubkeyHex,
    normalizedPayload,
  }
}

export function buildReplayUrl(origin, id) {
  return `${origin.replace(/\/$/, '')}/replay/${id}`
}
