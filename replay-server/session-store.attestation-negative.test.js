import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, randomUUID, sign as signDetached } from 'crypto'
import { gzipSync } from 'zlib'

import { parseReplayAttestation, verifyAndNormalizeSession } from './session-store.js'

const REPLAY_ATTESTATION_FORMAT_V1 = 'handtyped-replay-attestation-v1'
const REPLAY_ATTESTATION_FORMAT_V2 = 'handtyped-replay-attestation-v2'
const ED25519_SPKI_PREFIX_HEX = '302a300506032b6570032100'

function rawPublicKeyHexFromSpki(spkiDer) {
  const spkiHex = Buffer.from(spkiDer).toString('hex')
  if (!spkiHex.startsWith(ED25519_SPKI_PREFIX_HEX)) {
    throw new Error('Unexpected Ed25519 SPKI encoding in test helper')
  }
  return spkiHex.slice(ED25519_SPKI_PREFIX_HEX.length)
}

function publicKeyHex(keyPair) {
  return rawPublicKeyHexFromSpki(keyPair.publicKey.export({ format: 'der', type: 'spki' }))
}

function basePayload(overrides = {}) {
  return {
    session_id: `session-${randomUUID()}`,
    session_nonce: randomUUID(),
    document_name: 'Draft',
    doc_text: 'Hello world',
    doc_html: '<p>Hello world</p>',
    doc_history: [{ t: 0, text: 'H' }],
    focus_events: [],
    replay_origin_wall_ms: 1_700_000_000_000,
    keystroke_log: '{"t":1,"kind":"down","key":4}\n',
    keystroke_count: 1,
    start_wall_ns: 1_700_000_000_000_000_000,
    log_chain_hash: 'abc123',
    app_binary_hash: 'deadbeef',
    code_signing_valid: true,
    os_version: 'macOS 15.0',
    hardware_model: 'MacBookPro18,3',
    hardware_uuid: randomUUID(),
    sip_enabled: true,
    vm_detected: false,
    frida_detected: false,
    dylib_injection_detected: false,
    dyld_env_injection: false,
    keyboard_vendor_id: '0x05ac',
    keyboard_product_id: '0x1234',
    keyboard_transport: 'SPI',
    recorded_timezone: 'AST',
    recorded_timezone_offset_minutes: -240,
    ...overrides,
  }
}

function signedEnvelope(payloadOverrides = {}, keyPair = generateKeyPairSync('ed25519')) {
  const payload = basePayload(payloadOverrides)
  const payloadJson = JSON.stringify(payload)
  const payloadGzip = gzipSync(Buffer.from(payloadJson, 'utf8'))
  const signature = signDetached(null, payloadGzip, keyPair.privateKey)
  return {
    version: 2,
    format: REPLAY_ATTESTATION_FORMAT_V2,
    signer_pubkey_hex: publicKeyHex(keyPair),
    payload_gzip_b64: Buffer.from(payloadGzip).toString('base64'),
    signature_hex: Buffer.from(signature).toString('hex'),
  }
}

function legacySignedEnvelope(payloadOverrides = {}, keyPair = generateKeyPairSync('ed25519')) {
  const payload = basePayload(payloadOverrides)
  const payloadJson = JSON.stringify(payload)
  const signature = signDetached(null, Buffer.from(payloadJson, 'utf8'), keyPair.privateKey)
  return {
    version: 1,
    format: REPLAY_ATTESTATION_FORMAT_V1,
    signer_pubkey_hex: publicKeyHex(keyPair),
    payload_json: payloadJson,
    signature_hex: Buffer.from(signature).toString('hex'),
  }
}

describe('parseReplayAttestation negative cases', () => {
  const trustedKeyPair = generateKeyPairSync('ed25519')

  const envelopeCases = [
    {
      name: 'rejects non-object envelopes',
      envelope: null,
      message: 'Replay upload must be an object',
    },
    {
      name: 'rejects unsupported attestation versions',
      envelope: { version: 9, format: REPLAY_ATTESTATION_FORMAT_V2 },
      message: 'Unsupported replay attestation version',
    },
    {
      name: 'rejects unsupported attestation formats',
      envelope: { version: 2, format: 'bad-format' },
      message: 'Unsupported replay attestation format',
    },
    {
      name: 'rejects invalid signature hex',
      envelope: { ...signedEnvelope({}, trustedKeyPair), signature_hex: 'abc' },
      message: 'Invalid signature',
    },
    {
      name: 'rejects malformed signer public key length',
      envelope: { ...signedEnvelope({}, trustedKeyPair), signer_pubkey_hex: 'aa' },
      message: 'Invalid signer public key length',
    },
    {
      name: 'rejects invalid gzip payload base64',
      envelope: { ...signedEnvelope({}, trustedKeyPair), payload_gzip_b64: '*not-base64*' },
      message: 'Invalid payload gzip base64',
    },
    {
      name: 'rejects invalid payload json after decompression',
      envelope: (() => {
        const payloadGzip = gzipSync(Buffer.from('not-json', 'utf8'))
        const signature = signDetached(null, payloadGzip, trustedKeyPair.privateKey)
        return {
          version: 2,
          format: REPLAY_ATTESTATION_FORMAT_V2,
          signer_pubkey_hex: publicKeyHex(trustedKeyPair),
          payload_gzip_b64: Buffer.from(payloadGzip).toString('base64'),
          signature_hex: Buffer.from(signature).toString('hex'),
        }
      })(),
      message: 'Invalid replay attestation payload JSON',
    },
    {
      name: 'rejects signature mismatch for gzip payloads',
      envelope: { ...signedEnvelope({ doc_text: 'Hello world' }, trustedKeyPair), payload_gzip_b64: signedEnvelope({ doc_text: 'Different payload' }, trustedKeyPair).payload_gzip_b64 },
      message: 'Replay attestation signature verification failed',
    },
    {
      name: 'rejects signature mismatch for legacy payload_json envelopes',
      envelope: (() => {
        const envelope = legacySignedEnvelope({ doc_text: 'Legacy hello' }, trustedKeyPair)
        return { ...envelope, payload_json: JSON.stringify(basePayload({ doc_text: 'Legacy tamper' })) }
      })(),
      message: 'Replay attestation signature verification failed',
    },
  ]

  for (const testCase of envelopeCases) {
    it(testCase.name, async () => {
      await expect(parseReplayAttestation(testCase.envelope)).rejects.toThrow(testCase.message)
    })
  }

  const payloadCases = [
    {
      name: 'rejects frida detection flag',
      overrides: { frida_detected: true },
      message: 'Replay uploads rejected due to runtime tampering indicators',
    },
    {
      name: 'rejects dylib injection detection flag',
      overrides: { dylib_injection_detected: true },
      message: 'Replay uploads rejected due to runtime tampering indicators',
    },
    {
      name: 'rejects dyld env injection flag',
      overrides: { dyld_env_injection: true },
      message: 'Replay uploads rejected due to runtime tampering indicators',
    },
    {
      name: 'rejects untrusted keyboard transport',
      overrides: { keyboard_transport: 'USB' },
      message: 'Replay uploads require trusted built-in keyboard transport (SPI or FIFO)',
    },
    {
      name: 'rejects invalid focus event state',
      overrides: { focus_events: [{ t: 1, state: 'idle' }] },
      message: 'Invalid focus event state at index 0',
    },
    {
      name: 'rejects invalid focus event timestamp',
      overrides: { focus_events: [{ t: -1, state: 'active' }] },
      message: 'Invalid focus event timestamp at index 0',
    },
    {
      name: 'rejects non-finite timezone offsets',
      overrides: { recorded_timezone_offset_minutes: Number.NaN },
      message: 'Expected numeric field "recorded_timezone_offset_minutes"',
    },
  ]

  for (const testCase of payloadCases) {
    it(testCase.name, async () => {
      await expect(parseReplayAttestation(signedEnvelope(testCase.overrides, trustedKeyPair))).rejects.toThrow(
        testCase.message,
      )
    })
  }
})

describe('verifyAndNormalizeSession negative cases', () => {
  const trustedKeyPair = generateKeyPairSync('ed25519')
  const untrustedKeyPair = generateKeyPairSync('ed25519')

  it('rejects missing trusted signer configuration', async () => {
    await expect(
      verifyAndNormalizeSession(signedEnvelope({}, trustedKeyPair), {
        trustedSignerAllowlist: new Set(),
      }),
    ).rejects.toThrow('No trusted Handtyped public keys are configured')
  })

  it('rejects envelopes signed by untrusted public keys', async () => {
    await expect(
      verifyAndNormalizeSession(signedEnvelope({}, untrustedKeyPair), {
        trustedSignerAllowlist: new Set([publicKeyHex(trustedKeyPair)]),
      }),
    ).rejects.toThrow('Untrusted Handtyped signer public key')
  })
})
