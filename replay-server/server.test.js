/**
 * Integration tests for the Handtyped replay server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID, generateKeyPairSync, sign as signDetached } from 'crypto'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPLAY_ATTESTATION_FORMAT = 'handtyped-replay-attestation-v1'
const ED25519_SPKI_PREFIX_HEX = '302a300506032b6570032100'

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

async function request(method, path, body) {
  const url = `${baseUrl}${path}`
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(url, opts)
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

function basePayload(overrides = {}) {
  return {
    session_id: `session-${randomUUID()}`,
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
  const signature = signDetached(null, Buffer.from(payloadJson, 'utf8'), keyPair.privateKey)

  return {
    version: 1,
    format: REPLAY_ATTESTATION_FORMAT,
    signer_pubkey_hex: publicKeyHex(keyPair),
    payload_json: payloadJson,
    signature_hex: Buffer.from(signature).toString('hex'),
  }
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

describe('auto-bootstrap replay trust', () => {
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
    expect(body.url).toContain('/replay/')
  })
})

describe('POST /api/sessions', () => {
  it('accepts a valid signed replay attestation', async () => {
    const envelope = signedEnvelope()
    const { status, body } = await request('POST', '/api/sessions', envelope)

    expect(status).toBe(200)
    expect(body.id).toBeTruthy()
    expect(body.url).toContain('/replay/')
    expect(body.url).toContain(body.id)
  })

  it('stores verified session data on disk', async () => {
    const envelope = signedEnvelope({ doc_text: 'Saved to disk' })
    const { body } = await request('POST', '/api/sessions', envelope)
    const filePath = join(sessionsDir, `${body.id}.json`)

    expect(existsSync(filePath)).toBe(true)

    const stored = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(stored.doc_text).toBe('Saved to disk')
    expect(stored.verification.verified).toBe(true)
    expect(stored.verification.format).toBe(REPLAY_ATTESTATION_FORMAT)
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

describe('GET /replay/:id', () => {
  it('returns 200 HTML for a valid session', async () => {
    const { body: created } = await request('POST', '/api/sessions', signedEnvelope({ doc_text: 'replay test' }))
    const res = await fetch(`${baseUrl}/replay/${created.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('returns 200 HTML even for unknown ids (SPA-style routing)', async () => {
    const res = await fetch(`${baseUrl}/replay/${randomUUID()}`)
    expect(res.status).toBe(200)
  })
})
