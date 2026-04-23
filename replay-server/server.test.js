/**
 * Integration tests for the Handtyped replay server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID, generateKeyPairSync, sign as signDetached } from 'crypto'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { gzipSync, gunzipSync } from 'zlib'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPLAY_ATTESTATION_FORMAT_V1 = 'handtyped-replay-attestation-v1'
const REPLAY_ATTESTATION_FORMAT_V2 = 'handtyped-replay-attestation-v2'
const ED25519_SPKI_PREFIX_HEX = '302a300506032b6570032100'
const SHORT_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function shortId(length = 16) {
  const bytes = new Uint8Array(24)
  let id = ''
  while (id.length < length) {
    globalThis.crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte < 248) {
        id += SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length]
        if (id.length === length) return id
      }
    }
  }
  return id
}

let baseUrl
let server
let sessionsDir
let trustedSignerKeyPair
let untrustedSignerKeyPair
let lateBootstrapServer
let lateBootstrapBaseUrl
let lateBootstrapDir
let lateBootstrapTrustFile
let lateBootstrapKeyPair
let lateBootstrapPort

async function request(method, path, body, headers = {}) {
  const url = `${baseUrl}${path}`
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(url, opts)
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

function basePayload(overrides = {}) {
  return {
    session_id: shortId(),
    session_nonce: randomUUID(),
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

function signedEnvelope(payloadOverrides = {}, keyPair = trustedSignerKeyPair) {
  const payload = basePayload(payloadOverrides)
  const payloadJson = JSON.stringify(payload)
  const payloadGzip = gzipSync(Buffer.from(payloadJson, 'utf8'))
  const signature = signDetached(null, payloadGzip, keyPair.privateKey)

  return {
    version: 2,
    format: REPLAY_ATTESTATION_FORMAT_V2,
    signer_pubkey_hex: publicKeyHex(keyPair),
    payload_json: undefined,
    payload_gzip_b64: Buffer.from(payloadGzip).toString('base64'),
    signature_hex: Buffer.from(signature).toString('hex'),
  }
}

function legacySignedEnvelope(payloadOverrides = {}, keyPair = trustedSignerKeyPair) {
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

function payloadFromEnvelope(envelope) {
  if (envelope.payload_json) {
    return JSON.parse(envelope.payload_json)
  }

  if (envelope.payload_gzip_b64) {
    const payloadJson = gunzipSync(Buffer.from(envelope.payload_gzip_b64, 'base64')).toString(
      'utf8',
    )
    return JSON.parse(payloadJson)
  }

  throw new Error('Envelope missing payload field')
}

function smokeBlogDraftEnvelope() {
  const session_id = shortId()
  return signedEnvelope(
    {
      session_id,
      doc_text:
        '# Shipping a human-edited draft\n\n' +
        'I wanted the full path to survive the same way a reader would see it.\n\n' +
        'That meant preserving the paragraph breaks, timing, and one small typo.\n\n' +
        'The typo is comming so the smoke test can prove correction, undo, redo, save, quit, reopen, and replay all stay aligned.',
      doc_history: [
        { t: 0, text: '' },
        { t: 90, text: '#' },
        { t: 180, text: '# ' },
        { t: 270, text: '# S' },
        { t: 360, text: '# Sh' },
        { t: 450, text: '# Shi' },
        { t: 540, text: '# Ship' },
        { t: 630, text: '# Shipp' },
        { t: 720, text: '# Shippi' },
        { t: 810, text: '# Shippin' },
        { t: 900, text: '# Shipping a human-edited draft' },
        { t: 2100, text: '# Shipping a human-edited draft\n\n' },
        { t: 2190, text: '# Shipping a human-edited draft\n\nI' },
        { t: 2280, text: '# Shipping a human-edited draft\n\nI wanted the full path to survive the same way a reader would see it.' },
        { t: 3560, text: '# Shipping a human-edited draft\n\nI wanted the full path to survive the same way a reader would see it.\n\n' },
        { t: 3650, text: '# Shipping a human-edited draft\n\nI wanted the full path to survive the same way a reader would see it.\n\nThat meant preserving the paragraph breaks, timing, and one small typo.' },
        { t: 4830, text: '# Shipping a human-edited draft\n\nI wanted the full path to survive the same way a reader would see it.\n\nThat meant preserving the paragraph breaks, timing, and one small typo.\n\n' },
        { t: 4920, text: '# Shipping a human-edited draft\n\nI wanted the full path to survive the same way a reader would see it.\n\nThat meant preserving the paragraph breaks, timing, and one small typo.\n\nThe typo is comming' },
        { t: 5010, text: '# Shipping a human-edited draft\n\nI wanted the full path to survive the same way a reader would see it.\n\nThat meant preserving the paragraph breaks, timing, and one small typo.\n\nThe typo is comming ' },
        { t: 5100, text: '# Shipping a human-edited draft\n\nI wanted the full path to survive the same way a reader would see it.\n\nThat meant preserving the paragraph breaks, timing, and one small typo.\n\nThe typo is comming so the smoke test can prove correction, undo, redo, save, quit, reopen, and replay all stay aligned.' },
      ],
    },
    trustedSignerKeyPair,
  )
}

beforeAll(async () => {
  sessionsDir = join(__dirname, `sessions-test-${randomUUID()}`)
  mkdirSync(sessionsDir, { recursive: true })
  trustedSignerKeyPair = generateKeyPairSync('ed25519')
  untrustedSignerKeyPair = generateKeyPairSync('ed25519')

  const port = 10000 + Math.floor(Math.random() * 20000)
  baseUrl = `http://localhost:${port}`

  const { createApp } = await import('./server-lib.js')
  const app = createApp(sessionsDir, {
    trustedSignerKeys: [publicKeyHex(trustedSignerKeyPair)],
  })
  await new Promise((resolve) => {
    server = app.listen(port, resolve)
  })
})

afterAll(async () => {
  server?.close()
  if (sessionsDir && existsSync(sessionsDir)) {
    rmSync(sessionsDir, { recursive: true, force: true })
  }
})

describe('attestation compatibility', () => {
  it('still accepts legacy v1 payload_json envelopes', async () => {
    const payload = legacySignedEnvelope({ session_id: shortId() })
    const sessionId = payloadFromEnvelope(payload).session_id

    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toContain(`/${sessionId}`)
  })
})

describe('trusted signer file bootstrap', () => {
  beforeAll(async () => {
    lateBootstrapDir = join(__dirname, `sessions-late-bootstrap-${randomUUID()}`)
    mkdirSync(lateBootstrapDir, { recursive: true })
    lateBootstrapTrustFile = join(__dirname, `trusted-signers-${randomUUID()}.hex`)
    lateBootstrapKeyPair = generateKeyPairSync('ed25519')
    lateBootstrapPort = 20000 + Math.floor(Math.random() * 20000)
    lateBootstrapBaseUrl = `http://localhost:${lateBootstrapPort}`

    process.env.HANDTYPED_TRUSTED_SIGNER_FILE = lateBootstrapTrustFile

    const { createApp } = await import('./server-lib.js')
    const app = createApp(lateBootstrapDir)
    await new Promise((resolve) => {
      lateBootstrapServer = app.listen(lateBootstrapPort, resolve)
    })
  })

  afterAll(async () => {
    lateBootstrapServer?.close()
    delete process.env.HANDTYPED_TRUSTED_SIGNER_FILE
    if (lateBootstrapDir && existsSync(lateBootstrapDir)) {
      rmSync(lateBootstrapDir, { recursive: true, force: true })
    }
    if (lateBootstrapTrustFile && existsSync(lateBootstrapTrustFile)) {
      rmSync(lateBootstrapTrustFile, { force: true })
    }
  })

  it('rejects uploads before the trust file exists', async () => {
    const payload = signedEnvelope({}, lateBootstrapKeyPair)

    const res = await fetch(`${lateBootstrapBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('Untrusted Handtyped signer public key')
  })

  it('accepts uploads after the trust file appears later', async () => {
    const payload = signedEnvelope({}, lateBootstrapKeyPair)
    writeFileSync(lateBootstrapTrustFile, `${publicKeyHex(lateBootstrapKeyPair)}\n`)

    const res = await fetch(`${lateBootstrapBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toMatch(new RegExp(`/${body.id}$`))
  })
})

describe('POST /api/sessions', () => {
  it('accepts a valid signed replay attestation', async () => {
    const envelope = signedEnvelope()
    const sessionId = payloadFromEnvelope(envelope).session_id
    const { status, body } = await request('POST', '/api/sessions', envelope)

    expect(status).toBe(200)
    expect(body.id).toBe(sessionId)
    expect(body.url).toMatch(new RegExp(`/${body.id}$`))
    expect(body.id).toHaveLength(16)
  })

  it('stores verified session data on disk', async () => {
    const envelope = signedEnvelope({ doc_text: 'Saved to disk' })
    const { body } = await request('POST', '/api/sessions', envelope)
    const filePath = join(sessionsDir, `${body.id}.json`)

    expect(existsSync(filePath)).toBe(true)

    const stored = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(stored.doc_text).toBe('Saved to disk')
    expect(stored.verification.verified).toBe(true)
    expect(stored.verification.format).toBe(REPLAY_ATTESTATION_FORMAT_V2)
  })

  it('stores Handtyped active and inactive focus transitions', async () => {
    const focus_events = [
      { t: 1200, state: 'inactive' },
      { t: 5200, state: 'active' },
    ]
    const replay_origin_wall_ms = 1_700_000_100_000
    const envelope = signedEnvelope({ focus_events, replay_origin_wall_ms })
    const { body } = await request('POST', '/api/sessions', envelope)
    const stored = JSON.parse(readFileSync(join(sessionsDir, `${body.id}.json`), 'utf8'))

    expect(stored.focus_events).toEqual(focus_events)
    expect(stored.replay_origin_wall_ms).toBe(replay_origin_wall_ms)
  })

  it('reuses the same replay id for repeat uploads from one session', async () => {
    const session_id = shortId()
    const firstEnvelope = signedEnvelope({ session_id, doc_text: 'first version' })
    const secondEnvelope = signedEnvelope({ session_id, doc_text: 'second version' })

    const first = await request('POST', '/api/sessions', firstEnvelope)
    const second = await request('POST', '/api/sessions', secondEnvelope)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.id).toBe(session_id)
    expect(second.body.id).toBe(session_id)
    expect(first.body.url).toBe(second.body.url)
    expect(first.body.url).toMatch(new RegExp(`/${session_id}$`))
    expect(session_id).toHaveLength(16)

    const stored = JSON.parse(readFileSync(join(sessionsDir, `${session_id}.json`), 'utf8'))
    expect(stored.doc_text).toBe('second version')
    expect(stored.created_at).toBeTruthy()
    expect(stored.updated_at).toBeTruthy()
  })

  it('rejects legacy unsigned JSON payloads', async () => {
    const { status, body } = await request('POST', '/api/sessions', {
      session_id: 'legacy',
      doc_text: 'forged',
    })

    expect(status).toBe(400)
    expect(body.error).toContain('Unsupported replay attestation')
  })

  it('rejects tampered signatures', async () => {
    const envelope = signedEnvelope()
    envelope.signature_hex = envelope.signature_hex.replace(/.$/, envelope.signature_hex.endsWith('0') ? '1' : '0')

    const { status, body } = await request('POST', '/api/sessions', envelope)
    expect(status).toBe(400)
    expect(body.error).toContain('signature verification failed')
  })

  it('rejects valid signatures from untrusted signers', async () => {
    const envelope = signedEnvelope({}, untrustedSignerKeyPair)
    const { status, body } = await request('POST', '/api/sessions', envelope)

    expect(status).toBe(400)
    expect(body.error).toContain('Untrusted Handtyped signer public key')
  })

  it('rejects non-SPI keyboards even with a valid signature', async () => {
    const envelope = signedEnvelope({ keyboard_transport: 'USB' })
    const { status, body } = await request('POST', '/api/sessions', envelope)

    expect(status).toBe(400)
    expect(body.error).toContain('SPI keyboard transport')
  })

  it('rejects runtime tampering indicators even with a valid signature', async () => {
    const envelope = signedEnvelope({ frida_detected: true })
    const { status, body } = await request('POST', '/api/sessions', envelope)

    expect(status).toBe(400)
    expect(body.error).toContain('tampering indicators')
  })

  it('rejects malformed focus transitions even with a valid signature', async () => {
    const envelope = signedEnvelope({
      focus_events: [{ t: 1200, state: 'background-tab' }],
    })
    const { status, body } = await request('POST', '/api/sessions', envelope)

    expect(status).toBe(400)
    expect(body.error).toContain('Invalid focus event state')
  })
})

describe('smoke flow', () => {
  it('publishes a realistic draft and opens the replay page in-browser', async () => {
    const envelope = smokeBlogDraftEnvelope()
    const sessionId = payloadFromEnvelope(envelope).session_id

    const post = await request('POST', '/api/sessions', envelope)
    expect(post.status).toBe(200)
    expect(post.body.id).toBe(sessionId)
    expect(post.body.url).toMatch(new RegExp(`/${sessionId}$`))

    const page = await fetch(`${baseUrl}/${sessionId}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')

    const stored = await request('GET', `/api/sessions/${sessionId}`)
    expect(stored.status).toBe(200)
    expect(stored.body.markdown).toBeUndefined()
    expect(stored.body.doc_text).toContain('human-edited draft')
    expect(stored.body.doc_history.length).toBeGreaterThan(10)
    expect(stored.body.verification.verified).toBe(true)
  })
})

describe('rate limiting and monitoring', () => {
  let rateLimitedServer
  let rateLimitedBaseUrl
  let rateLimitedDir
  let rateLimitedPort

  beforeAll(async () => {
    rateLimitedDir = join(__dirname, `sessions-rate-limit-${randomUUID()}`)
    mkdirSync(rateLimitedDir, { recursive: true })
    rateLimitedPort = 30000 + Math.floor(Math.random() * 10000)
    rateLimitedBaseUrl = `http://localhost:${rateLimitedPort}`

    const { createApp } = await import('./server-lib.js')
    const app = createApp(rateLimitedDir, {
      trustedSignerKeys: [publicKeyHex(trustedSignerKeyPair)],
      uploadRateLimitCount: 2,
      uploadRateLimitWindowMs: 60_000,
    })
    await new Promise((resolve) => {
      rateLimitedServer = app.listen(rateLimitedPort, resolve)
    })
  })

  afterAll(async () => {
    rateLimitedServer?.close()
    if (rateLimitedDir && existsSync(rateLimitedDir)) {
      rmSync(rateLimitedDir, { recursive: true, force: true })
    }
  })

  it('reports replay health and trust source', async () => {
    const res = await fetch(`${rateLimitedBaseUrl}/api/health`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.replay_only).toBe(true)
    expect(body.trusted_signer_source).toContain('configured')
    expect(body.rate_limit.count).toBe(2)
    expect(body.rate_limit.window_ms).toBe(60_000)
  })

  it('rate limits repeated uploads from the same client ip', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.77',
    }
    const first = await fetch(`${rateLimitedBaseUrl}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(signedEnvelope({ session_id: shortId() })),
    })
    const second = await fetch(`${rateLimitedBaseUrl}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(signedEnvelope({ session_id: shortId() })),
    })
    const third = await fetch(`${rateLimitedBaseUrl}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(signedEnvelope({ session_id: shortId() })),
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)

    const health = await fetch(`${rateLimitedBaseUrl}/api/health`)
    const body = await health.json()
    expect(body.uploads.accepted_uploads).toBeGreaterThanOrEqual(2)
    expect(body.uploads.rate_limited_uploads).toBeGreaterThanOrEqual(1)
  })
})

describe('GET /api/sessions/:id', () => {
  it('returns the stored verified session', async () => {
    const { body: created } = await request('POST', '/api/sessions', signedEnvelope({
      doc_text: 'retrieved text',
      keystroke_count: 7,
    }))

    const { status, body } = await request('GET', `/api/sessions/${created.id}`)
    expect(status).toBe(200)
    expect(body.id).toBe(created.id)
    expect(body.doc_text).toBe('retrieved text')
    expect(body.keystroke_count).toBe(7)
    expect(body.verification.verified).toBe(true)
  })

  it('returns 404 for unknown id', async () => {
    const { status } = await request('GET', `/api/sessions/${randomUUID()}`)
    expect(status).toBe(404)
  })

  it('includes created_at timestamp', async () => {
    const before = Date.now()
    const { body: created } = await request('POST', '/api/sessions', signedEnvelope({ doc_text: 'ts test' }))
    const { body } = await request('GET', `/api/sessions/${created.id}`)
    const ts = new Date(body.created_at).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(Date.now())
  })
})

describe('GET /:id and /replay/:id', () => {
  it('returns 200 HTML for a valid session', async () => {
    const { body: created } = await request('POST', '/api/sessions', signedEnvelope({ doc_text: 'replay test' }))
    const res = await fetch(`${baseUrl}/${created.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('returns 200 HTML for the legacy replay alias', async () => {
    const { body: created } = await request('POST', '/api/sessions', signedEnvelope({ doc_text: 'replay test' }))
    const res = await fetch(`${baseUrl}/replay/${created.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('returns 200 HTML even for unknown ids (SPA-style routing)', async () => {
    const res = await fetch(`${baseUrl}/${randomUUID()}`)
    expect(res.status).toBe(200)
  })
})
