import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as signDetached, randomUUID } from 'crypto'
import { gzipSync, gunzipSync } from 'zlib'
import worker from './worker.js'

function makeEnv() {
  return {
    REPLAY_TRUSTED_SIGNER_KEYS: '',
    REPLAY_UPLOAD_RATE_LIMIT_COUNT: '',
    REPLAY_UPLOAD_RATE_LIMIT_WINDOW_MS: '',
    ASSETS: {
      async fetch(requestOrUrl) {
        const url = requestOrUrl instanceof URL ? requestOrUrl : new URL(requestOrUrl.url)
        return new Response(`asset:${url.pathname}`)
      },
    },
    SESSIONS: {
      async get() {
        return null
      },
      async put() {},
    },
  }
}

const ED25519_SPKI_PREFIX_HEX = '302a300506032b6570032100'
const legacyTrustedSignerKeyPair = generateKeyPairSync('ed25519')

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

function signedEnvelope(keyPair = generateKeyPairSync('ed25519')) {
  const payload = {
    session_id: randomUUID().replace(/-/g, '').slice(0, 16),
    session_nonce: randomUUID(),
    doc_text: 'Hello world',
    doc_html: '<p>Hello world</p>',
    doc_history: [{ t: 0, text: 'H' }],
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
  }
  const payloadJson = JSON.stringify(payload)
  const payloadGzip = gzipSync(Buffer.from(payloadJson, 'utf8'))
  const signature = signDetached(null, payloadGzip, keyPair.privateKey)
  return {
    version: 2,
    format: 'handtyped-replay-attestation-v2',
    signer_pubkey_hex: publicKeyHex(keyPair),
    payload_json: undefined,
    payload_gzip_b64: Buffer.from(payloadGzip).toString('base64'),
    signature_hex: Buffer.from(signature).toString('hex'),
  }
}

function legacySignedEnvelope(payloadOverrides = {}, keyPair = generateKeyPairSync('ed25519')) {
  const payload = {
    session_id: randomUUID().replace(/-/g, '').slice(0, 16),
    session_nonce: randomUUID(),
    doc_text: 'Hello world',
    doc_html: '<p>Hello world</p>',
    doc_history: [{ t: 0, text: 'H' }],
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
    ...payloadOverrides,
  }
  const payloadJson = JSON.stringify(payload)
  const signature = signDetached(null, Buffer.from(payloadJson, 'utf8'), keyPair.privateKey)
  return {
    version: 1,
    format: 'handtyped-replay-attestation-v1',
    signer_pubkey_hex: publicKeyHex(keyPair),
    payload_json: payloadJson,
    signature_hex: Buffer.from(signature).toString('hex'),
  }
}

function payloadFromEnvelope(envelope) {
  if (envelope.payload_json) {
    return JSON.parse(envelope.payload_json)
  }

  const payloadJson = gunzipSync(Buffer.from(envelope.payload_gzip_b64, 'base64')).toString('utf8')
  return JSON.parse(payloadJson)
}

describe('worker host routing', () => {
  it('returns 404 at the replay host root', async () => {
    const res = await worker.fetch(new Request('https://replay.handtyped.app/', { method: 'GET' }), makeEnv())

    expect(res.status).toBe(404)
  })

  it('serves the replay page for a short replay id', async () => {
    const res = await worker.fetch(
      new Request('https://replay.handtyped.app/abc123def456ghi7', { method: 'GET' }),
      makeEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/replay.html')
  })

  it('keeps the landing page available on the app host root', async () => {
    const res = await worker.fetch(new Request('https://handtyped.app/', { method: 'GET' }), makeEnv())

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/')
  })
})

describe('worker trust bootstrap', () => {
  it('rejects untrusted signers when no allowlist source is configured', async () => {
    const res = await worker.fetch(
      new Request('https://replay.handtyped.app/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedEnvelope()),
      }),
      makeEnv(),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'Untrusted Handtyped signer public key',
    })
  })
})

describe('worker attestation compatibility', () => {
  it('still accepts legacy v1 payload_json envelopes', async () => {
    const legacyPayload = legacySignedEnvelope({}, legacyTrustedSignerKeyPair)
    const trustedEnv = {
      ...makeEnv(),
      REPLAY_TRUSTED_SIGNER_KEYS: publicKeyHex(legacyTrustedSignerKeyPair),
    }

    const res = await worker.fetch(
      new Request('https://replay.handtyped.app/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyPayload),
      }),
      trustedEnv,
    )

    expect(res.status).toBe(200)
  })
})

describe('worker monitoring and throttling', () => {
  const trustedSignerKeyPair = generateKeyPairSync('ed25519')

  function env() {
    return {
      ...makeEnv(),
      REPLAY_TRUSTED_SIGNER_KEYS: publicKeyHex(trustedSignerKeyPair),
      REPLAY_UPLOAD_RATE_LIMIT_COUNT: '1',
      REPLAY_UPLOAD_RATE_LIMIT_WINDOW_MS: '60000',
    }
  }

  it('reports replay health', async () => {
    const res = await worker.fetch(
      new Request('https://replay.handtyped.app/api/health', { method: 'GET' }),
      env(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      replay_only: true,
      rate_limit: { count: 1, window_ms: 60000 },
    })
  })

  it('rate limits repeated uploads from the same client ip', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.88',
    }

    const first = await worker.fetch(
      new Request('https://replay.handtyped.app/api/sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify(signedEnvelope(trustedSignerKeyPair)),
      }),
      env(),
    )
    const second = await worker.fetch(
      new Request('https://replay.handtyped.app/api/sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify(signedEnvelope(trustedSignerKeyPair)),
      }),
      env(),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
  })
})
