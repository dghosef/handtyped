/**
 * Integration tests for the Handtyped replay server.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
const TEST_TEACHER_EMAIL = 'actual-teacher@edu.handtyped.app'
const TEST_TEACHER_PASSWORD = 'actual-teacher-password'

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
let eduStoreDir
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

let passwordTeacherReady = false

async function ensurePasswordTeacher() {
  if (passwordTeacherReady) {
    return
  }
  const res = await fetch(`${baseUrl}/api/edu/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Actual Teacher',
      email: TEST_TEACHER_EMAIL,
      password: TEST_TEACHER_PASSWORD,
    }),
  })
  if (res.status !== 201 && res.status !== 400) {
    throw new Error(`Could not create test teacher account: ${res.status}`)
  }
  passwordTeacherReady = true
}

async function teacherLogin() {
  await ensurePasswordTeacher()
  const res = await fetch(`${baseUrl}/api/edu/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'password',
      email: TEST_TEACHER_EMAIL,
      password: TEST_TEACHER_PASSWORD,
    }),
  })
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: res.headers.get('set-cookie') || '',
  }
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
  eduStoreDir = join(sessionsDir, 'edu-store')
  mkdirSync(sessionsDir, { recursive: true })
  trustedSignerKeyPair = generateKeyPairSync('ed25519')
  untrustedSignerKeyPair = generateKeyPairSync('ed25519')

  const port = 10000 + Math.floor(Math.random() * 20000)
  baseUrl = `http://localhost:${port}`

  const { createApp } = await import('./server-lib.js')
  const app = createApp(sessionsDir, {
    eduStoreDir,
    trustedSignerKeys: [publicKeyHex(trustedSignerKeyPair)],
    googleClientId: 'test-google-client-id',
    googleTokenVerifier: async (credential) => {
      if (credential !== 'valid-google-credential') {
        if (credential === 'new-google-teacher-credential') {
          return {
            sub: 'google-new-teacher',
            email: 'new-google-teacher@edu.handtyped.app',
            email_verified: true,
            aud: 'test-google-client-id',
            name: 'New Google Teacher',
          }
        }
        if (credential !== 'valid-google-credential-2') {
          throw new Error('invalid google credential')
        }
        return {
          sub: 'google-sub-2',
          email: 'teacher@edu.handtyped.app',
          email_verified: true,
          aud: 'test-google-client-id',
          name: 'Joseph Tan',
        }
      }
      return {
        sub: 'google-sub-1',
        email: 'teacher@edu.handtyped.app',
        email_verified: true,
        aud: 'test-google-client-id',
        name: 'Joseph Tan',
      }
    },
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

describe('teacher auth', () => {
  it('publishes Google auth config for the teacher login page', async () => {
    const res = await fetch(`${baseUrl}/api/edu/config`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      auth: {
        password_enabled: true,
        google_enabled: true,
        google_client_id: 'test-google-client-id',
      },
    })
  })

  it('signs in a teacher with email and password', async () => {
    const result = await teacherLogin()

    expect(result.status).toBe(200)
    expect(result.cookie).toContain('edu_teacher_session=')
    expect(result.body).toMatchObject({
      authenticated: true,
      teacher_email: TEST_TEACHER_EMAIL,
      provider: 'password',
    })
  })

  it('creates a teacher account with email and password', async () => {
    const res = await fetch(`${baseUrl}/api/edu/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ms. Signup',
        email: 'signup-teacher@edu.handtyped.app',
        password: 'longenoughpassword',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(201)
    const cookie = res.headers.get('set-cookie') || ''
    expect(cookie).toContain('edu_teacher_session=')
    expect(body).toMatchObject({
      authenticated: true,
      teacher_email: 'signup-teacher@edu.handtyped.app',
      provider: 'password',
    })
    expect(body.tenant_id).toMatch(/^tenant_/)
    expect(body.tenant_id).not.toBe('tenant_demo')

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, { Cookie: cookie })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body).toMatchObject({
      classrooms: [],
      assignments: [],
    })

    const classrooms = await request('GET', '/api/edu/classrooms', undefined, { Cookie: cookie })
    expect(classrooms.status).toBe(200)
    expect(classrooms.body).toEqual([])
  })

  it('rejects duplicate classroom join codes across teacher accounts', async () => {
    const firstSignup = await fetch(`${baseUrl}/api/edu/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'First Teacher',
        email: `first-${shortId(6).toLowerCase()}@edu.handtyped.app`,
        password: 'longenoughpassword',
      }),
    })
    expect(firstSignup.status).toBe(201)
    const firstCookie = firstSignup.headers.get('set-cookie') || ''

    const secondSignup = await fetch(`${baseUrl}/api/edu/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Second Teacher',
        email: `second-${shortId(6).toLowerCase()}@edu.handtyped.app`,
        password: 'longenoughpassword',
      }),
    })
    expect(secondSignup.status).toBe(201)
    const secondCookie = secondSignup.headers.get('set-cookie') || ''

    const joinCode = `GLB${shortId(5)}`
    const firstClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      { name: 'First Global Join Code', join_code: joinCode },
      { Cookie: firstCookie },
    )
    expect(firstClassroom.status).toBe(201)

    const duplicateClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      { name: 'Second Global Join Code', join_code: joinCode.toLowerCase() },
      { Cookie: secondCookie },
    )
    expect(duplicateClassroom.status).toBe(409)
    expect(duplicateClassroom.body).toMatchObject({
      error: 'Join code already in use',
      join_code: joinCode.toUpperCase(),
    })
  })

  it('generates unused classroom join codes when teachers leave them blank', async () => {
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const firstClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      { name: `Generated Code ${shortId(6)}` },
      { Cookie: login.cookie },
    )
    expect(firstClassroom.status).toBe(201)
    expect(firstClassroom.body.join_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(firstClassroom.body.join_code).not.toBe('JOINME')

    const secondClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      { name: `Generated Blank Code ${shortId(6)}`, join_code: '   ' },
      { Cookie: login.cookie },
    )
    expect(secondClassroom.status).toBe(201)
    expect(secondClassroom.body.join_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(secondClassroom.body.join_code).not.toBe(firstClassroom.body.join_code)
    expect(secondClassroom.body.join_code).not.toBe('JOINME')
  })

  it('rejects duplicate teacher signup emails', async () => {
    const duplicateEmail = `duplicate-${shortId(6).toLowerCase()}@edu.handtyped.app`
    const first = await fetch(`${baseUrl}/api/edu/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Teacher',
        email: duplicateEmail,
        password: 'longenoughpassword',
      }),
    })
    expect(first.status).toBe(201)

    const res = await fetch(`${baseUrl}/api/edu/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Teacher Again',
        email: duplicateEmail,
        password: 'longenoughpassword',
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      authenticated: false,
      error: 'A teacher account with that email already exists',
    })
  })

  it('signs in a teacher with Google', async () => {
    const res = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        credential: 'valid-google-credential',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') || '').toContain('edu_teacher_session=')
    expect(body).toMatchObject({
      authenticated: true,
      teacher_email: 'teacher@edu.handtyped.app',
      provider: 'google',
    })
  })

  it('creates a private teacher account from a verified Google login when no teacher exists yet', async () => {
    const res = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        credential: 'new-google-teacher-credential',
      }),
    })
    const body = await res.json()
    const cookie = res.headers.get('set-cookie') || ''

    expect(res.status).toBe(200)
    expect(cookie).toContain('edu_teacher_session=')
    expect(body).toMatchObject({
      authenticated: true,
      teacher_email: 'new-google-teacher@edu.handtyped.app',
      teacher_name: 'New Google Teacher',
      provider: 'google',
    })
    expect(body.tenant_id).toMatch(/^tenant_/)
    expect(body.tenant_id).not.toBe('tenant_demo')

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, { Cookie: cookie })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body).toMatchObject({
      classrooms: [],
      assignments: [],
    })
  })

  it('rejects a different Google subject for the same teacher email once linked', async () => {
    const res = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        credential: 'valid-google-credential-2',
      }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      authenticated: false,
      error: 'Invalid teacher login',
    })
  })

  it('serves the teacher login and app shells at production-style paths', async () => {
    const loginRes = await fetch(`${baseUrl}/login`)
    const appRes = await fetch(`${baseUrl}/app`)

    expect(loginRes.status).toBe(200)
    expect(appRes.status).toBe(200)
    expect(await loginRes.text()).toContain('Sign in to Handtyped EDU')
    expect(await appRes.text()).toContain('Handtyped EDU Teacher App')
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

describe('edu teacher and student flow', () => {
  it('supports classroom creation, student config join, and live replay publishing', async () => {
    const joinCode = `APL${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)
    expect(login.body).toMatchObject({
      authenticated: true,
      teacher_email: TEST_TEACHER_EMAIL,
    })

    const createClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'AP Literature',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(createClassroom.status).toBe(201)
    expect(createClassroom.body).toMatchObject({
      name: 'AP Literature',
      join_code: joinCode.toUpperCase(),
    })

    const createAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Hamlet timed write',
        course: 'AP Literature',
        classroom_id: createClassroom.body.id,
        classroom_name: createClassroom.body.name,
        prompt: 'Write about indecision in Hamlet.',
        editor_policy: {
          font_family: 'sans',
          font_size: 24,
          line_height: 'double',
        },
      },
      { Cookie: login.cookie },
    )
    expect(createAssignment.status).toBe(201)
    expect(createAssignment.body).toMatchObject({
      title: 'Hamlet timed write',
      classroom_id: createClassroom.body.id,
      editor_policy: {
        font_family: 'sans',
        font_size: 24,
        line_height: 'double',
      },
    })

    const studentConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}`,
      undefined,
    )
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body).toMatchObject({
      classroom: { join_code: joinCode.toUpperCase(), name: 'AP Literature' },
      assignments: [
        {
          title: 'Hamlet timed write',
          classroom_id: createClassroom.body.id,
          editor_policy: {
            font_family: 'sans',
            font_size: 24,
            line_height: 'double',
          },
        },
      ],
    })

    const replayId = 'edu-replay-integration'
    const liveSessionId = 'student:hamlet'

    const replayPublish = await request('POST', '/api/edu/replays', {
      id: replayId,
      live_session_id: liveSessionId,
      assignment_id: createAssignment.body.id,
      assignment_title: createAssignment.body.title,
      course: createAssignment.body.course,
      classroom: createClassroom.body.name,
      student_name: 'Ada',
      current_text: 'Hamlet delays because certainty never arrives.',
      document_history: [{ op: 'insert', text: 'Hamlet delays because certainty never arrives.' }],
      url_history: [],
      violations: [],
    })
    expect(replayPublish.status).toBe(201)

    const livePublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: createAssignment.body.id,
      assignment_title: createAssignment.body.title,
      course: createAssignment.body.course,
      classroom: createClassroom.body.name,
      student_name: 'Ada',
      current_text: 'Hamlet delays because certainty never arrives.',
      document_history: [{ op: 'insert', text: 'Hamlet delays because certainty never arrives.' }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-25T00:00:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
      replay_session_id: replayId,
    })
    expect(livePublish.status).toBe(201)
    expect(livePublish.body).toMatchObject({ replay_session_id: replayId })

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, { Cookie: login.cookie })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          student_name: 'Ada',
          replay_session_id: replayId,
        }),
      ]),
    )

    const replayRead = await request('GET', `/api/edu/replays/${replayId}`, undefined, {
      Cookie: login.cookie,
    })
    expect(replayRead.status).toBe(200)
    expect(replayRead.body).toMatchObject({
      id: replayId,
      student_name: 'Ada',
      assignment_title: 'Hamlet timed write',
    })
  })

  it('falls back to live session snapshots when a teacher opens a missing replay record', async () => {
    const login = await teacherLogin()
    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      { name: 'Live replay fallback', join_code: `LRF${shortId(5)}` },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        classroom_id: classroom.body.id,
        title: 'Fallback draft',
        course: 'English 11',
        classroom_name: classroom.body.name,
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = `fallback-student-${shortId(6)}`
    const documentHistory = [{ t: 1_000, ins: 'Recovered from live snapshot.', del: '', pos: 0 }]
    const livePublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: 'Recovered from live snapshot.',
      document_history: documentHistory,
      focus_events: [{ t: 1_000, state: 'focused' }],
      url_history: [{ at: '2026-04-27T12:00:00Z', url: 'https://example.test/draft' }],
      violation_count: 0,
      violations: [{ kind: 'blocked-url', at: '2026-04-27T12:00:02Z' }],
      last_activity_at: '2026-04-27T12:00:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
      replay_session_id: `replay:${liveSessionId}`,
    })
    expect(livePublish.status).toBe(201)

    const prefixedReplayRead = await request('GET', `/api/edu/replays/replay:${liveSessionId}`, undefined, {
      Cookie: login.cookie,
    })
    expect(prefixedReplayRead.status).toBe(200)
    expect(prefixedReplayRead.body).toMatchObject({
      id: `replay:${liveSessionId}`,
      live_session_id: liveSessionId,
      student_name: 'Ada',
      current_text: 'Recovered from live snapshot.',
      document_history: documentHistory,
      assignment: expect.objectContaining({ id: assignment.body.id }),
    })

    const directReplayRead = await request('GET', `/api/edu/replays/${liveSessionId}`, undefined, {
      Cookie: login.cookie,
    })
    expect(directReplayRead.status).toBe(200)
    expect(directReplayRead.body).toMatchObject({
      id: liveSessionId,
      live_session_id: liveSessionId,
      current_text: 'Recovered from live snapshot.',
    })
  })

  it('reflects assignment create, update, and delete changes in student config', async () => {
    const joinCode = `REA${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const createClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Realtime Literature',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(createClassroom.status).toBe(201)

    const createAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Draft one',
        course: 'Realtime Literature',
        classroom_id: createClassroom.body.id,
        classroom_name: createClassroom.body.name,
        prompt: 'Start with a quick draft.',
      },
      { Cookie: login.cookie },
    )
    expect(createAssignment.status).toBe(201)

    const initialConfig = await request('GET', `/api/edu/student/config?join_code=${joinCode}`)
    expect(initialConfig.status).toBe(200)
    expect(initialConfig.body).toMatchObject({
      classroom: { join_code: joinCode.toUpperCase(), name: 'Realtime Literature' },
      assignments: [
        {
          id: createAssignment.body.id,
          title: 'Draft one',
          prompt: 'Start with a quick draft.',
        },
      ],
    })

    const updatedWindows = [
      {
        label: 'Updated window',
        days: {
          monday: true,
          tuesday: false,
          wednesday: true,
          thursday: false,
          friday: true,
          saturday: false,
          sunday: false,
        },
        end_date: '2026-05-30',
        start_hour: 9,
        start_minute: 15,
        end_hour: 10,
        end_minute: 45,
      },
    ]

    const updateAssignment = await request(
      'PUT',
      `/api/edu/assignments/${createAssignment.body.id}`,
      {
        title: 'Draft two',
        prompt: 'Revised prompt for the same class.',
        windows: updatedWindows,
      },
      { Cookie: login.cookie },
    )
    expect(updateAssignment.status).toBe(200)
    expect(updateAssignment.body).toMatchObject({
      id: createAssignment.body.id,
      title: 'Draft two',
      prompt: 'Revised prompt for the same class.',
      windows: updatedWindows,
    })

    const updatedConfig = await request('GET', `/api/edu/student/config?join_code=${joinCode}`)
    expect(updatedConfig.status).toBe(200)
    expect(updatedConfig.body).toMatchObject({
      classroom: { join_code: joinCode.toUpperCase(), name: 'Realtime Literature' },
      assignments: [
        {
          id: createAssignment.body.id,
          title: 'Draft two',
          prompt: 'Revised prompt for the same class.',
          windows: updatedWindows,
        },
      ],
    })

    const deleteAssignment = await request(
      'DELETE',
      `/api/edu/assignments/${createAssignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(deleteAssignment.status).toBe(200)
    expect(deleteAssignment.body).toMatchObject({
      deleted: true,
      assignment_id: createAssignment.body.id,
    })

    const assignmentAudit = await request(
      'GET',
      `/api/edu/assignments/${createAssignment.body.id}/audit`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(assignmentAudit.status).toBe(404)

    const deletedConfig = await request('GET', `/api/edu/student/config?join_code=${joinCode}`)
    expect(deletedConfig.status).toBe(200)
    expect(deletedConfig.body).toMatchObject({
      classroom: { join_code: joinCode.toUpperCase(), name: 'Realtime Literature' },
      assignments: [],
    })
  })

  it('preserves teacher inline review data across later live-session sync updates', async () => {
    const joinCode = `REV${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Review Writing',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Live feedback essay',
        course: 'Review Writing',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Draft quickly and revise from teacher feedback.',
        policy: { allow_offline_editing: false },
        rubric: [
          { id: 'claim', title: 'Claim', description: 'Clear argument', points: 4 },
          { id: 'evidence', title: 'Evidence', description: 'Specific support', points: 4 },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = 'review:student'
    const initialLive = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: 'Hamlet delays because certainty never arrives.',
      document_history: [{ op: 'insert', text: 'Hamlet delays because certainty never arrives.' }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-27T12:00:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(initialLive.status).toBe(201)

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      {
        rubric_scores: { claim: 3, evidence: 4 },
        teacher_comment: 'Push the thesis one step further.',
        returned_for_revision: true,
        grade_label: 'A-',
        grade_score: 91,
        inline_annotations: [
          {
            type: 'comment',
            start: 0,
            end: 14,
            quote: 'Hamlet delays',
            note: 'Clarify what kind of delay this is.',
          },
          {
            type: 'suggestion',
            start: 15,
            end: 22,
            quote: 'because',
            replacement: 'since',
            note: 'Try a tighter connector here.',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(grading.status).toBe(200)
    expect(grading.body.grading).toMatchObject({
      grade_label: 'A-',
      grade_score: 91,
      returned_for_revision: true,
      inline_annotations: [
        expect.objectContaining({ type: 'comment', quote: 'Hamlet delays' }),
        expect.objectContaining({ type: 'suggestion', replacement: 'since' }),
      ],
    })

    const studentSyncUpdate = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: 'Hamlet delays because certainty never fully arrives for him.',
      document_history: [{ op: 'insert', text: 'Hamlet delays because certainty never fully arrives for him.' }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-27T12:01:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(studentSyncUpdate.status).toBe(201)
    expect(studentSyncUpdate.body.grading).toMatchObject({
      grade_label: 'A-',
      teacher_comment: 'Push the thesis one step further.',
    })

    const persisted = await request('GET', `/api/edu/live-sessions/${liveSessionId}`, undefined, {
      Cookie: login.cookie,
    })
    expect(persisted.status).toBe(200)
    expect(persisted.body).toMatchObject({
      id: liveSessionId,
      current_text: 'Hamlet delays because certainty never fully arrives for him.',
      grading: {
        grade_label: 'A-',
        grade_score: 91,
        returned_for_revision: true,
        teacher_comment: 'Push the thesis one step further.',
        inline_annotations: [
          expect.objectContaining({ type: 'comment', quote: 'Hamlet delays' }),
          expect.objectContaining({ type: 'suggestion', replacement: 'since' }),
        ],
      },
    })
  })

  it('shows student draft edits on the teacher dashboard after each live-session update', async () => {
    const joinCode = `LIV${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Live Monitor',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Live dashboard check',
        course: 'Live Monitor',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Make sure student edits appear for the teacher.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = 'teacher-dashboard:student'
    const firstDraft = 'The first draft appears in teacher monitoring.'
    const secondDraft = 'The revised draft appears in teacher monitoring after the student edits again.'

    const firstPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: firstDraft,
      document_history: [{ op: 'insert', text: firstDraft }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T12:10:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(firstPublish.status).toBe(201)
    expect(firstPublish.body.tenant_id).toBe(assignment.body.tenant_id)

    const firstDashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(firstDashboard.status).toBe(200)
    expect(firstDashboard.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          student_name: 'Ada',
          current_text: firstDraft,
        }),
      ]),
    )

    const sinceCursor = new Date(Date.parse(firstDashboard.body.updated_at) - 1).toISOString()

    const secondPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: secondDraft,
      document_history: [{ op: 'insert', text: secondDraft }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T12:11:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(secondPublish.status).toBe(201)

    const secondDashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(secondDashboard.status).toBe(200)
    expect(secondDashboard.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          student_name: 'Ada',
          current_text: secondDraft,
        }),
      ]),
    )

    const teacherLiveView = await request(
      'GET',
      `/api/edu/live-sessions/${liveSessionId}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherLiveView.status).toBe(200)
    expect(teacherLiveView.body).toMatchObject({
      id: liveSessionId,
      student_name: 'Ada',
      current_text: secondDraft,
      document_history: [{ op: 'insert', text: secondDraft }],
    })

    const delta = await request(
      'GET',
      `/api/edu/dashboard/updates?since=${encodeURIComponent(sinceCursor)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(delta.status).toBe(200)
    expect(delta.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          current_text: secondDraft,
        }),
      ]),
    )
  })

  it('shows teacher feedback, suggestions, and inline annotations in teacher-facing session reads and dashboard updates', async () => {
    const joinCode = `FDB${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Feedback Workshop',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Teacher feedback check',
        course: 'Feedback Workshop',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Verify teacher feedback survives round-trips.',
        policy: { allow_offline_editing: false },
        rubric: [
          { id: 'idea', title: 'Idea', description: 'Clear controlling idea', points: 4 },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = 'teacher-feedback:student'
    const livePublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: 'This sentence needs a clearer claim.',
      document_history: [{ op: 'insert', text: 'This sentence needs a clearer claim.' }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T12:20:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(livePublish.status).toBe(201)

    const beforeGradingDashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(beforeGradingDashboard.status).toBe(200)

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      {
        rubric_scores: { idea: 3 },
        teacher_comment: 'Strong start, but make the thesis more specific.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 78,
        inline_annotations: [
          {
            type: 'comment',
            start: 0,
            end: 13,
            quote: 'This sentence',
            note: 'Name the idea more directly.',
          },
          {
            type: 'suggestion',
            start: 20,
            end: 35,
            quote: 'clearer claim',
            replacement: 'more specific thesis',
            note: 'This will sharpen the paragraph.',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(grading.status).toBe(200)

    const teacherRead = await request('GET', `/api/edu/live-sessions/${liveSessionId}`, undefined, {
      Cookie: login.cookie,
    })
    expect(teacherRead.status).toBe(200)
    expect(teacherRead.body).toMatchObject({
      id: liveSessionId,
      current_text: 'This sentence needs a clearer claim.',
        grading: {
          rubric_scores: { idea: 3 },
          teacher_comment: 'Strong start, but make the thesis more specific.',
          returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 78,
        inline_annotations: [
          expect.objectContaining({
            type: 'comment',
            quote: 'This sentence',
            note: 'Name the idea more directly.',
          }),
          expect.objectContaining({
            type: 'suggestion',
            quote: 'clearer claim',
            replacement: 'more specific thesis',
            note: 'This will sharpen the paragraph.',
          }),
        ],
      },
    })

    const afterGradingDashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(afterGradingDashboard.status).toBe(200)
    expect(afterGradingDashboard.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          grading: expect.objectContaining({
            teacher_comment: 'Strong start, but make the thesis more specific.',
            returned_for_revision: true,
            grade_label: 'Revise',
            grade_score: 78,
            inline_annotations: expect.arrayContaining([
              expect.objectContaining({ type: 'comment', quote: 'This sentence' }),
              expect.objectContaining({ type: 'suggestion', replacement: 'more specific thesis' }),
            ]),
          }),
        }),
      ]),
    )

    const delta = await request(
      'GET',
      `/api/edu/dashboard/updates?since=${encodeURIComponent(beforeGradingDashboard.body.updated_at)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(delta.status).toBe(200)
    expect(delta.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          grading: expect.objectContaining({
            teacher_comment: 'Strong start, but make the thesis more specific.',
            inline_annotations: expect.arrayContaining([
              expect.objectContaining({ type: 'comment', note: 'Name the idea more directly.' }),
              expect.objectContaining({ type: 'suggestion', replacement: 'more specific thesis' }),
            ]),
          }),
        }),
      ]),
    )
  })

  it('includes teacher feedback in the student config for the matching student', async () => {
    const joinCode = `SFB${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Revision Workshop',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Argument Revision',
        course: 'English 10',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Revise your claim and connect each piece of evidence back to it.',
        policy: { allow_offline_editing: false },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = 'student-feedback:ada'
    const livePublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'The draft still needs a stronger claim.',
      document_history: [{ op: 'insert', text: 'The draft still needs a stronger claim.' }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T13:05:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(livePublish.status).toBe(201)

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      {
        rubric_scores: { claim: 2, evidence: 3 },
        teacher_comment: 'You are close. Make the thesis more direct.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 79,
        inline_annotations: [
          {
            id: 'comment-1',
            type: 'comment',
            start: 0,
            end: 9,
            quote: 'The draft',
            note: 'Open with the actual argument instead.',
          },
          {
            id: 'suggestion-1',
            type: 'suggestion',
            start: 27,
            end: 41,
            quote: 'stronger claim',
            replacement: 'clear thesis',
            note: 'Say exactly what you want to prove.',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(grading.status).toBe(200)

    const resolution = await request(
      'POST',
      `/api/edu/student/assignments/${assignment.body.id}/feedback-resolutions`,
      {
        join_code: joinCode,
        student_name: 'Ada Lovelace',
        annotation_key: 'id:comment-1',
      },
    )
    expect(resolution.status).toBe(200)

    const adaConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(adaConfig.status).toBe(200)
    expect(adaConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          student_feedback: expect.objectContaining({
            rubric_scores: { claim: 2, evidence: 3 },
            teacher_comment: 'You are close. Make the thesis more direct.',
            returned_for_revision: true,
            grade_label: 'Revise',
            grade_score: '79',
            inline_annotations: expect.arrayContaining([
              expect.objectContaining({
                id: 'comment-1',
                type: 'comment',
                quote: 'The draft',
                note: 'Open with the actual argument instead.',
                resolved_by_student: true,
                resolved_by: 'Ada Lovelace',
              }),
              expect.objectContaining({
                id: 'suggestion-1',
                type: 'suggestion',
                quote: 'stronger claim',
                replacement: 'clear thesis',
                note: 'Say exactly what you want to prove.',
              }),
            ]),
          }),
        }),
      ]),
    )

    const graceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(graceConfig.status).toBe(200)
    expect(graceConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          student_feedback: null,
        }),
      ]),
    )

    const deletedFeedback = await request(
      'DELETE',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(deletedFeedback.status).toBe(200)
    expect(deletedFeedback.body.grading).toMatchObject({
      teacher_comment: '',
      returned_for_revision: false,
      grade_label: '',
      grade_score: null,
      inline_annotations: [],
      feedback_status: 'draft',
      published_at: null,
    })

    const adaConfigAfterDelete = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(adaConfigAfterDelete.status).toBe(200)
    expect(adaConfigAfterDelete.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          student_feedback: null,
        }),
      ]),
    )
  })

  it('preserves the last known student draft when a later live-session sync sends blank text', async () => {
    const joinCode = `BLK${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Live Presence',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Presence draft',
        course: 'Live Presence',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Keep the live preview stable while the app reports presence.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = 'presence:student'
    const initialPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: 'A live draft should stay visible to teachers.',
      document_history: [{ op: 'insert', text: 'A live draft should stay visible to teachers.' }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T12:00:00Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(initialPublish.status).toBe(201)

    const blankPresencePublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: '',
      document_history: [],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T12:01:00Z',
      schedule_open: false,
      focused: false,
      hid_active: false,
    })
    expect(blankPresencePublish.status).toBe(201)
    expect(blankPresencePublish.body).toMatchObject({
      id: liveSessionId,
      current_text: 'A live draft should stay visible to teachers.',
      document_history: [{ op: 'insert', text: 'A live draft should stay visible to teachers.' }],
      schedule_open: false,
      focused: false,
      hid_active: false,
    })

    const persisted = await request('GET', `/api/edu/live-sessions/${liveSessionId}`, undefined, {
      Cookie: login.cookie,
    })
    expect(persisted.status).toBe(200)
    expect(persisted.body).toMatchObject({
      id: liveSessionId,
      current_text: 'A live draft should stay visible to teachers.',
      document_history: [{ op: 'insert', text: 'A live draft should stay visible to teachers.' }],
    })

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          current_text: 'A live draft should stay visible to teachers.',
        }),
      ]),
    )
  })

  it('keeps the latest revised live draft visible after a close-style blank presence update', async () => {
    const joinCode = `CLS${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Close Persistence',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Close and reopen draft',
        course: 'Live Presence',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Keep the newest text visible after close.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = 'close-latest:student'
    const openingDraft = 'Opening paragraph'
    const revisedDraft = 'Opening paragraph with a stronger revised claim.'

    expect(
      await request('POST', '/api/edu/live-sessions', {
        id: liveSessionId,
        assignment_id: assignment.body.id,
        assignment_title: assignment.body.title,
        course: assignment.body.course,
        classroom: classroom.body.name,
        student_name: 'Ada',
        current_text: openingDraft,
        document_history: [{ op: 'insert', text: openingDraft }],
        current_url: null,
        current_url_title: null,
        url_history: [],
        violation_count: 0,
        violations: [],
        last_activity_at: '2026-04-28T12:00:00Z',
        schedule_open: true,
        focused: true,
        hid_active: true,
      }),
    ).toMatchObject({ status: 201 })

    expect(
      await request('POST', '/api/edu/live-sessions', {
        id: liveSessionId,
        assignment_id: assignment.body.id,
        assignment_title: assignment.body.title,
        course: assignment.body.course,
        classroom: classroom.body.name,
        student_name: 'Ada',
        current_text: revisedDraft,
        document_history: [
          { op: 'insert', text: openingDraft },
          { op: 'insert', text: ' with a stronger revised claim.' },
        ],
        current_url: null,
        current_url_title: null,
        url_history: [],
        violation_count: 0,
        violations: [],
        last_activity_at: '2026-04-28T12:02:00Z',
        schedule_open: true,
        focused: true,
        hid_active: true,
      }),
    ).toMatchObject({ status: 201 })

    const closePublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: '',
      document_history: [],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T12:03:00Z',
      schedule_open: false,
      focused: false,
      hid_active: false,
    })
    expect(closePublish.status).toBe(201)
    expect(closePublish.body).toMatchObject({
      id: liveSessionId,
      current_text: revisedDraft,
      document_history: [
        { op: 'insert', text: openingDraft },
        { op: 'insert', text: ' with a stronger revised claim.' },
      ],
      schedule_open: false,
      focused: false,
      hid_active: false,
    })

    const persisted = await request('GET', `/api/edu/live-sessions/${liveSessionId}`, undefined, {
      Cookie: login.cookie,
    })
    expect(persisted.status).toBe(200)
    expect(persisted.body.current_text).toBe(revisedDraft)

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          current_text: revisedDraft,
        }),
      ]),
    )
  })

  it('preserves replay timing metadata for teacher replay analysis', async () => {
    const joinCode = `RPL${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Replay Analysis',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'After-school audit',
        course: 'Replay Analysis',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        windows: [
          {
            label: 'Class block',
            days: {
              monday: true,
              tuesday: true,
              wednesday: true,
              thursday: true,
              friday: true,
              saturday: false,
              sunday: false,
            },
            start_hour: 10,
            start_minute: 0,
            end_hour: 15,
            end_minute: 15,
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const replayId = 'edu-replay-metadata'
    const replayPublish = await request('POST', '/api/edu/replays', {
      id: replayId,
      live_session_id: 'replay:metadata:student',
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada',
      current_text: 'Hello world',
      document_history: [
        { op: 'insert', text: 'Hello' },
        { op: 'insert', text: ' world' },
      ],
      focus_events: [{ t: 2_000, state: 'inactive' }],
      url_history: [],
      violations: [],
      last_activity_at: '2026-04-28T12:02:00Z',
      focused: true,
      hid_active: true,
      start_wall_ns: 1_700_000_000_000_000_000,
      replay_origin_wall_ms: 1_700_000_000_000,
      recorded_timezone: 'AST',
      recorded_timezone_offset_minutes: -240,
    })
    expect(replayPublish.status).toBe(201)

    const replayRead = await request('GET', `/api/edu/replays/${replayId}`, undefined, {
      Cookie: login.cookie,
    })
    expect(replayRead.status).toBe(200)
    expect(replayRead.body).toMatchObject({
      id: replayId,
      student_name: 'Ada',
      replay_origin_wall_ms: 1_700_000_000_000,
      recorded_timezone: 'AST',
      recorded_timezone_offset_minutes: -240,
      start_wall_ns: 1_700_000_000_000_000_000,
      assignment: expect.objectContaining({
        id: assignment.body.id,
        title: 'After-school audit',
      }),
    })
    expect(replayRead.body.document_history).toEqual([
      { op: 'insert', text: 'Hello' },
      { op: 'insert', text: ' world' },
    ])
  })

  it('deletes assignments for authenticated teachers', async () => {
    const joinCode = `DEL${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const createClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Delete Literature',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(createClassroom.status).toBe(201)

    const createAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Delete me',
        course: 'Delete Literature',
        classroom_id: createClassroom.body.id,
        classroom_name: createClassroom.body.name,
        prompt: 'This assignment should be removable.',
      },
      { Cookie: login.cookie },
    )
    expect(createAssignment.status).toBe(201)

    const deleteAssignment = await request(
      'DELETE',
      `/api/edu/assignments/${createAssignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(deleteAssignment.status).toBe(200)
    expect(deleteAssignment.body).toMatchObject({
      deleted: true,
      assignment_id: createAssignment.body.id,
    })

    const assignments = await request('GET', '/api/edu/assignments', undefined, {
      Cookie: login.cookie,
    })
    expect(assignments.status).toBe(200)
    expect(assignments.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: createAssignment.body.id })]),
    )

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body.assignment_audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignment_id: createAssignment.body.id,
          action: 'deleted',
          assignment_title: 'Delete me',
        }),
      ]),
    )
    expect(dashboard.body.assignments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: createAssignment.body.id })]),
    )
  })

  it('includes linked assignment ids in student config', async () => {
    const joinCode = `LNK${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const createClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Linked Literature',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(createClassroom.status).toBe(201)

    const priorAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Draft one',
        course: 'Linked Literature',
        classroom_id: createClassroom.body.id,
        classroom_name: createClassroom.body.name,
        prompt: 'Write your first draft.',
      },
      { Cookie: login.cookie },
    )
    expect(priorAssignment.status).toBe(201)

    const linkedAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Draft two',
        course: 'Linked Literature',
        classroom_id: createClassroom.body.id,
        classroom_name: createClassroom.body.name,
        prompt: 'Revise with access to your first draft.',
        linked_assignment_ids: [priorAssignment.body.id],
      },
      { Cookie: login.cookie },
    )
    expect(linkedAssignment.status).toBe(201)

    const studentConfig = await request('GET', `/api/edu/student/config?join_code=${joinCode}`)
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: linkedAssignment.body.id,
          linked_assignment_ids: [priorAssignment.body.id],
        }),
      ]),
    )
  })

  it('returns the latest linked assignment draft in student assignment payloads', async () => {
    const joinCode = `LNK${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Linked Drafts',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const priorAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Test Suggestions',
        course: 'Linked Literature',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Write your first draft.',
      },
      { Cookie: login.cookie },
    )
    expect(priorAssignment.status).toBe(201)

    const linkedAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Revision',
        course: 'Linked Literature',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Revise with access to the latest draft.',
        linked_assignment_ids: [priorAssignment.body.id],
      },
      { Cookie: login.cookie },
    )
    expect(linkedAssignment.status).toBe(201)

    const latestDraft = 'The linked draft now has the newest saved claim.'
    expect(
      await request('POST', '/api/edu/live-sessions', {
        id: 'linked-latest:ada',
        assignment_id: priorAssignment.body.id,
        assignment_title: priorAssignment.body.title,
        course: priorAssignment.body.course,
        classroom: classroom.body.name,
        student_name: 'Ada Lovelace',
        current_text: latestDraft,
        document_history: [{ op: 'insert', text: latestDraft }],
        current_url: null,
        current_url_title: null,
        url_history: [],
        violation_count: 0,
        violations: [],
        last_activity_at: '2026-04-28T12:02:00Z',
        schedule_open: true,
        focused: true,
        hid_active: true,
      }),
    ).toMatchObject({ status: 201 })

    const payload = await request(
      'GET',
      `/api/edu/student/assignments/${linkedAssignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )

    expect(payload.status).toBe(200)
    expect(payload.body.linked_references).toEqual([
      expect.objectContaining({
        assignment_id: priorAssignment.body.id,
        title: 'Test Suggestions',
        available: true,
        markdown: latestDraft,
        word_count: 9,
      }),
    ])
  })

  it('allows creating assignments without an essay prompt', async () => {
    const joinCode = `NOP${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const createClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Silent Reading',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(createClassroom.status).toBe(201)

    const createAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Notebook check-in',
        course: 'Silent Reading',
        classroom_id: createClassroom.body.id,
        classroom_name: createClassroom.body.name,
        prompt: '',
      },
      { Cookie: login.cookie },
    )
    expect(createAssignment.status).toBe(201)
    expect(createAssignment.body).toMatchObject({
      title: 'Notebook check-in',
      prompt: '',
    })

    const studentConfig = await request('GET', `/api/edu/student/config?join_code=${joinCode}`)
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body).toMatchObject({
      classroom: { join_code: joinCode.toUpperCase(), name: 'Silent Reading' },
      assignments: [
        {
          id: createAssignment.body.id,
          title: 'Notebook check-in',
          prompt: '',
        },
      ],
    })
  })

  it('rejects duplicate classroom join codes case-insensitively', async () => {
    const joinCode = `ENG${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const first = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'First Period',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(first.status).toBe(201)

    const duplicate = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Second Period',
        teacher_name: 'Ms. Keating',
        join_code: joinCode.toLowerCase(),
      },
      { Cookie: login.cookie },
    )
    expect(duplicate.status).toBe(409)
    expect(duplicate.body).toMatchObject({
      error: 'Join code already in use',
      join_code: joinCode.toUpperCase(),
    })
  })

  it('rejects duplicate classroom names and assignment titles across create and rename flows', async () => {
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const firstClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'English 11',
        teacher_name: 'Ms. Keating',
        join_code: `NAM${shortId(5)}`,
      },
      { Cookie: login.cookie },
    )
    expect(firstClassroom.status).toBe(201)

    const duplicateClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: '  english   11 ',
        teacher_name: 'Ms. Keating',
        join_code: `NMB${shortId(5)}`,
      },
      { Cookie: login.cookie },
    )
    expect(duplicateClassroom.status).toBe(409)
    expect(duplicateClassroom.body).toMatchObject({
      error: 'Classroom name already in use',
      name: '  english   11 ',
    })

    const secondClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'History 9',
        teacher_name: 'Ms. Keating',
        join_code: `NMC${shortId(5)}`,
      },
      { Cookie: login.cookie },
    )
    expect(secondClassroom.status).toBe(201)

    const duplicateClassroomRename = await request(
      'PUT',
      `/api/edu/classrooms/${secondClassroom.body.id}`,
      {
        name: '  ENGLISH 11  ',
      },
      { Cookie: login.cookie },
    )
    expect(duplicateClassroomRename.status).toBe(409)
    expect(duplicateClassroomRename.body).toMatchObject({
      error: 'Classroom name already in use',
      name: '  ENGLISH 11  ',
    })

    const firstAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Rhetorical Analysis',
        course: firstClassroom.body.name,
        classroom_id: firstClassroom.body.id,
        classroom_name: firstClassroom.body.name,
      },
      { Cookie: login.cookie },
    )
    expect(firstAssignment.status).toBe(201)

    const duplicateAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: ' rhetorical   analysis ',
        course: secondClassroom.body.name,
        classroom_id: secondClassroom.body.id,
        classroom_name: secondClassroom.body.name,
      },
      { Cookie: login.cookie },
    )
    expect(duplicateAssignment.status).toBe(409)
    expect(duplicateAssignment.body).toMatchObject({
      error: 'Assignment title already in use',
      title: ' rhetorical   analysis ',
    })

    const secondAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Poetry Response',
        course: secondClassroom.body.name,
        classroom_id: secondClassroom.body.id,
        classroom_name: secondClassroom.body.name,
      },
      { Cookie: login.cookie },
    )
    expect(secondAssignment.status).toBe(201)

    const duplicateAssignmentRename = await request(
      'PUT',
      `/api/edu/assignments/${secondAssignment.body.id}`,
      {
        title: ' RHETORICAL ANALYSIS ',
      },
      { Cookie: login.cookie },
    )
    expect(duplicateAssignmentRename.status).toBe(409)
    expect(duplicateAssignmentRename.body).toMatchObject({
      error: 'Assignment title already in use',
      title: ' RHETORICAL ANALYSIS ',
    })
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

  it('accepts FIFO keyboards with a valid signature', async () => {
    const envelope = signedEnvelope({ keyboard_transport: 'FIFO' })
    const { status } = await request('POST', '/api/sessions', envelope)

    expect([200, 201]).toContain(status)
  })

  it('rejects non-built-in keyboards even with a valid signature', async () => {
    const envelope = signedEnvelope({ keyboard_transport: 'USB' })
    const { status, body } = await request('POST', '/api/sessions', envelope)

    expect(status).toBe(400)
    expect(body.error).toContain('trusted built-in keyboard transport')
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

describe('per-student assignment extensions', () => {
  it('returns a personalized temporary access deadline for the matching student only', async () => {
    const { cookie } = await teacherLogin()
    const joinCode = `EXT${shortId(5).toUpperCase()}`

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Extensions',
        teacher_name: 'Joseph Tan',
        join_code: joinCode,
      },
      { Cookie: cookie },
    )

    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Timed Write',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        temporary_access_until: '2026-04-27T18:00:00.000Z',
        student_temporary_access_until: {
          'ada lovelace': '2026-04-27T19:30:00.000Z',
        },
      },
      { Cookie: cookie },
    )

    expect(assignment.status).toBe(201)

    const adaConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )

    expect(adaConfig.status).toBe(200)
    expect(adaConfig.body.assignments[0]).toMatchObject({
      id: assignment.body.id,
      temporary_access_until: '2026-04-27T19:30:00.000Z',
      student_temporary_access_until: {},
    })
    expect(graceConfig.status).toBe(200)
    expect(graceConfig.body.assignments[0]).toMatchObject({
      id: assignment.body.id,
      temporary_access_until: '2026-04-27T18:00:00.000Z',
      student_temporary_access_until: {},
    })
  })

  it('lets a blocked student request access and gives them a teacher-picked end time when class is closed', async () => {
    const joinCode = `REQ${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'After Hours',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Exit Ticket',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        windows: [
          {
            label: 'Teacher writing window',
            days: {
              monday: true,
              tuesday: true,
              wednesday: true,
              thursday: true,
              friday: true,
              saturday: false,
              sunday: false,
            },
            start_hour: 8,
            start_minute: 0,
            end_hour: 9,
            end_minute: 0,
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const accessRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
      },
    )
    expect(accessRequest.status).toBe(201)
    expect(accessRequest.body.student_access_request).toMatchObject({
      student_name: 'Ada Lovelace',
    })

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          student_access_requests: expect.objectContaining({
            'ada lovelace': expect.objectContaining({ student_name: 'Ada Lovelace' }),
          }),
        }),
      ]),
    )

    const feedbackRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/feedback-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'Please check my thesis.',
      },
    )
    expect(feedbackRequest.status).toBe(201)
    expect(feedbackRequest.body.student_feedback_request).toMatchObject({
      student_name: 'Ada Lovelace',
      note: 'Please check my thesis.',
    })

    const feedbackDashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(feedbackDashboard.status).toBe(200)
    expect(feedbackDashboard.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          student_feedback_requests: expect.objectContaining({
            'ada lovelace': expect.objectContaining({ student_name: 'Ada Lovelace' }),
          }),
        }),
      ]),
    )

    const approvedUntil = '2026-04-28T18:30:00.000Z'
    const approvedAssignment = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_access_requests: {},
        student_temporary_access_until: {
          'ada lovelace': approvedUntil,
        },
      },
      { Cookie: login.cookie },
    )
    expect(approvedAssignment.status).toBe(200)

    const studentConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          temporary_access_until: approvedUntil,
          student_access_request: null,
        }),
      ]),
    )
  })

  it('clears feedback requests when dismissed or when a newer student draft syncs', async () => {
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Feedback Lifecycle Local',
        teacher_name: 'Ms. Keating',
        join_code: `FBC${shortId(5)}`,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Feedback Lifecycle ${shortId(4)}`,
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const firstRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/feedback-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'Duplicate request.',
      },
    )
    expect(firstRequest.status).toBe(201)

    const dismiss = await request(
      'DELETE',
      `/api/edu/assignments/${assignment.body.id}/feedback-requests/${encodeURIComponent('Ada Lovelace')}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(dismiss.status).toBe(200)
    expect(dismiss.body).toMatchObject({
      assignment_id: assignment.body.id,
      dismissed: true,
      student_name: 'Ada Lovelace',
      student_feedback_request: null,
    })
    expect(dismiss.body.assignment.student_feedback_requests).not.toHaveProperty('ada lovelace')

    const secondRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/feedback-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'Please review this version.',
      },
    )
    expect(secondRequest.status).toBe(201)

    const sessionId = `feedback-local:${assignment.body.id}`
    const staleSync = await request('POST', '/api/edu/live-sessions', {
      id: sessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'Older draft sync.',
      document_history: [{ op: 'insert', text: 'Older draft sync.' }],
      last_activity_at: '2026-04-27T12:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(staleSync.status).toBe(201)

    const afterStaleSync = await request('GET', '/api/edu/dashboard', undefined, { Cookie: login.cookie })
    expect(afterStaleSync.status).toBe(200)
    expect(afterStaleSync.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          student_feedback_requests: expect.objectContaining({
            'ada lovelace': expect.objectContaining({ note: 'Please review this version.' }),
          }),
        }),
      ]),
    )

    const newerSync = await request('POST', '/api/edu/live-sessions', {
      id: sessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'New draft after request.',
      document_history: [{ op: 'insert', text: 'New draft after request.' }],
      last_activity_at: new Date(Date.now() + 1000).toISOString(),
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(newerSync.status).toBe(201)

    const afterNewerSync = await request('GET', '/api/edu/dashboard', undefined, { Cookie: login.cookie })
    expect(afterNewerSync.status).toBe(200)
    const dashboardAssignment = afterNewerSync.body.assignments.find((item) => item.id === assignment.body.id)
    expect(dashboardAssignment.student_feedback_requests).not.toHaveProperty('ada lovelace')
  })

  it('approves a student request into the normal class window when the assignment is already open', async () => {
    const joinCode = `OPN${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Open Block',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const openUntil = '2099-01-01T23:59:59.000Z'
    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Warmup',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        temporary_access_until: openUntil,
        student_temporary_access_until: {
          'ada lovelace': '2099-01-02T00:30:00.000Z',
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const accessRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
      },
    )
    expect(accessRequest.status).toBe(201)

    const approvedAssignment = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_access_requests: {},
        student_temporary_access_until: {},
      },
      { Cookie: login.cookie },
    )
    expect(approvedAssignment.status).toBe(200)

    const studentConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          temporary_access_until: openUntil,
          access_revoked: false,
          student_access_request: null,
          student_temporary_access_until: {},
        }),
      ]),
    )
  })

  it('requires teacher approval before a student can rejoin after leaving a protected assignment', async () => {
    const joinCode = `REJ${shortId(5)}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Protected Rejoin',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const openUntil = '2099-01-01T23:59:59.000Z'
    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Protected draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        temporary_access_until: openUntil,
        policy: {
          require_lockdown: true,
          require_permission_to_rejoin: true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const beforeLeave = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(beforeLeave.status).toBe(200)
    expect(beforeLeave.body).toMatchObject({
      schedule_open: true,
      assignment: {
        access_revoked: false,
        policy: { require_permission_to_rejoin: true },
      },
    })

    const close = await request(
      'POST',
      `/api/edu/student/assignments/${assignment.body.id}/close`,
      {
        join_code: joinCode,
        student_name: 'Ada Lovelace',
      },
    )
    expect(close.status).toBe(201)
    expect(close.body).toMatchObject({
      recorded: true,
      access_revoked: true,
      student_name: 'Ada Lovelace',
    })

    const blockedRejoin = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(blockedRejoin.status).toBe(200)
    expect(blockedRejoin.body).toMatchObject({
      schedule_open: false,
      session_end_at: null,
      assignment: {
        access_revoked: true,
        policy: { require_permission_to_rejoin: true },
      },
    })

    const accessRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'I accidentally left Handtyped.',
      },
    )
    expect(accessRequest.status).toBe(201)

    const waitingForApproval = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(waitingForApproval.status).toBe(200)
    expect(waitingForApproval.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          access_revoked: true,
          student_access_request: expect.objectContaining({
            student_name: 'Ada Lovelace',
            note: 'I accidentally left Handtyped.',
          }),
        }),
      ]),
    )

    const approved = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_access_revoked: {},
        student_access_requests: {},
      },
      { Cookie: login.cookie },
    )
    expect(approved.status).toBe(200)

    const afterApproval = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterApproval.status).toBe(200)
    expect(afterApproval.body).toMatchObject({
      schedule_open: true,
      assignment: {
        access_revoked: false,
        student_access_request: null,
      },
    })
  })

  it('allows a student to rejoin a protected assignment when a later scheduled period starts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-05-04T09:30:00-04:00'))
    try {
      const joinCode = `PER${shortId(5)}`
      const login = await teacherLogin()
      expect(login.status).toBe(200)

      const classroom = await request(
        'POST',
        '/api/edu/classrooms',
        {
          name: 'Period Rejoin',
          teacher_name: 'Ms. Keating',
          join_code: joinCode,
        },
        { Cookie: login.cookie },
      )
      expect(classroom.status).toBe(201)

      const assignment = await request(
        'POST',
        '/api/edu/assignments',
        {
          title: 'Two-period draft',
          course: classroom.body.name,
          classroom_id: classroom.body.id,
          classroom_name: classroom.body.name,
          assigned_students: ['Ada Lovelace'],
          windows: [
            {
              label: 'First period',
              days: {
                monday: true,
                tuesday: false,
                wednesday: false,
                thursday: false,
                friday: false,
                saturday: false,
                sunday: false,
              },
              end_date: '2026-05-04',
              start_hour: 9,
              start_minute: 0,
              end_hour: 10,
              end_minute: 0,
            },
            {
              label: 'Second period',
              days: {
                monday: true,
                tuesday: false,
                wednesday: false,
                thursday: false,
                friday: false,
                saturday: false,
                sunday: false,
              },
              end_date: '2026-05-04',
              start_hour: 11,
              start_minute: 0,
              end_hour: 12,
              end_minute: 0,
            },
          ],
          policy: {
            require_lockdown: true,
            require_permission_to_rejoin: true,
          },
        },
        { Cookie: login.cookie },
      )
      expect(assignment.status).toBe(201)

      const firstPeriod = await request(
        'GET',
        `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
      )
      expect(firstPeriod.status).toBe(200)
      expect(firstPeriod.body).toMatchObject({
        schedule_open: true,
        session_end_at: '2026-05-04T14:00:00.000Z',
        assignment: {
          access_revoked: false,
        },
      })

      const close = await request(
        'POST',
        `/api/edu/student/assignments/${assignment.body.id}/close`,
        {
          join_code: joinCode,
          student_name: 'Ada Lovelace',
        },
      )
      expect(close.status).toBe(201)

      const blockedSamePeriod = await request(
        'GET',
        `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
      )
      expect(blockedSamePeriod.status).toBe(200)
      expect(blockedSamePeriod.body).toMatchObject({
        schedule_open: false,
        assignment: {
          access_revoked: true,
        },
      })

      vi.setSystemTime(new Date('2026-05-04T11:30:00-04:00'))
      const laterPeriod = await request(
        'GET',
        `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
      )
      expect(laterPeriod.status).toBe(200)
      expect(laterPeriod.body).toMatchObject({
        schedule_open: true,
        session_end_at: '2026-05-04T16:00:00.000Z',
        assignment: {
          access_revoked: false,
          student_access_request: null,
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces per-student instant access revocation in student config', async () => {
    const joinCode = `REV${shortId(5)}`
    const cookie = (await teacherLogin()).cookie

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'English 12',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'In-class close read',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        temporary_access_until: '2099-01-01T23:59:59.000Z',
        student_access_revoked: {
          'ada lovelace': true,
        },
      },
      { Cookie: cookie },
    )
    expect(assignment.status).toBe(201)

    const revokedConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(revokedConfig.status).toBe(200)
    expect(revokedConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          access_revoked: true,
          student_access_revoked: {},
        }),
      ]),
    )

    const openConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(openConfig.status).toBe(200)
    expect(openConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          access_revoked: false,
        }),
      ]),
    )
  })

  it('returns lightweight live summaries and direct single-assignment student config', async () => {
    const joinCode = `LIV${shortId(5)}`
    const cookie = (await teacherLogin()).cookie

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'English 10',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Live Draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
      },
      { Cookie: cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSession = await request('POST', '/api/edu/live-sessions', {
      id: `Ada Lovelace:${assignment.body.id}`,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'Draft opening paragraph',
      document_history: [{ t: 1, ins: 'Draft', del: '', pos: 0 }],
      focus_events: [{ t: 1, state: 'focused' }],
      url_history: [
        { url: 'https://example.com/1' },
        { url: 'https://example.com/2' },
        { url: 'https://example.com/3' },
        { url: 'https://example.com/4' },
        { url: 'https://example.com/5' },
      ],
      violation_count: 0,
      violations: [],
      last_activity_at: new Date().toISOString(),
      schedule_open: true,
      focused: true,
      hid_active: true,
      updated_at: new Date().toISOString(),
    })
    expect(liveSession.status).toBe(201)

    const summaries = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/live-summaries`,
      undefined,
      { Cookie: cookie },
    )
    expect(summaries.status).toBe(200)
    expect(summaries.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `Ada Lovelace:${assignment.body.id}`,
          assignment_id: assignment.body.id,
          current_text: 'Draft opening paragraph',
          recent_edit_count: expect.any(Number),
        }),
      ]),
    )
    expect(summaries.body.live_sessions[0].document_history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ins: 'Draft' }),
      ]),
    )
    expect(summaries.body.live_sessions[0].url_history).toHaveLength(4)

    const studentAssignment = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentAssignment.status).toBe(200)
    expect(studentAssignment.body.assignment).toMatchObject({
      id: assignment.body.id,
      access_revoked: false,
    })
  })

  it('shows targeted assignments only to the assigned students in the same class', async () => {
    const joinCode = `TAR${shortId(5)}`
    const cookie = (await teacherLogin()).cookie

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `English 11 ${joinCode}`,
        teacher_name: 'Joseph Tan',
        join_code: joinCode,
      },
      { Cookie: cookie },
    )
    expect(classroom.status).toBe(201)

    const wholeClass = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Whole class draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
      },
      { Cookie: cookie },
    )
    const targeted = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Ada only draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
      },
      { Cookie: cookie },
    )

    expect(wholeClass.status).toBe(201)
    expect(targeted.status).toBe(201)

    const adaConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )

    expect(adaConfig.status).toBe(200)
    expect(adaConfig.body.classroom.students).toEqual(['Ada Lovelace'])
    expect(adaConfig.body.assignments.map((assignment) => assignment.title).sort()).toEqual([
      'Ada only draft',
      'Whole class draft',
    ])

    expect(graceConfig.status).toBe(200)
    expect(graceConfig.body.classroom.students).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(graceConfig.body.assignments.map((assignment) => assignment.title).sort()).toEqual([
      'Whole class draft',
    ])
  })

  it('applies per-student setting overrides in student config responses', async () => {
    const joinCode = `OVR${shortId(5)}`
    const cookie = (await teacherLogin()).cookie

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `English 11 ${joinCode}`,
        teacher_name: 'Joseph Tan',
        join_code: joinCode,
      },
      { Cookie: cookie },
    )

    expect(classroom.status).toBe(201)

    const created = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Differentiated write',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        policy: {
          allow_dictation: false,
          copy_paste_allowed: false,
        },
        editor_policy: {
          font_family: 'arial',
          font_size: 22,
          line_height: 'relaxed',
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://www.gutenberg.org',
          allowed_domains: ['gutenberg.org'],
        },
        student_overrides: {
          'ada lovelace': {
            student_name: 'Ada Lovelace',
            policy: {
              allow_dictation: true,
              copy_paste_allowed: true,
            },
            editor_policy: {
              font_size: 28,
            },
            browser_policy: {
              browser_enabled: false,
            },
          },
        },
      },
      { Cookie: cookie },
    )

    expect(created.status).toBe(201)

    const adaConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )

    expect(adaConfig.status).toBe(200)
    expect(adaConfig.body.assignments[0]).toMatchObject({
      student_overrides: {},
      policy: {
        allow_dictation: true,
        copy_paste_allowed: true,
      },
      editor_policy: {
        font_size: 28,
      },
      browser_policy: {
        browser_enabled: false,
      },
    })

    expect(graceConfig.status).toBe(200)
    expect(graceConfig.body.assignments[0]).toMatchObject({
      student_overrides: {},
      policy: {
        allow_dictation: false,
        copy_paste_allowed: false,
      },
      editor_policy: {
        font_size: 22,
      },
      browser_policy: {
        browser_enabled: true,
      },
    })
  })

  it('persists assignment PDF references into student config responses', async () => {
    const joinCode = `PDF${shortId(5)}`
    const cookie = (await teacherLogin()).cookie

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `English 11 ${joinCode}`,
        teacher_name: 'Joseph Tan',
        join_code: joinCode,
      },
      { Cookie: cookie },
    )

    expect(classroom.status).toBe(201)

    const created = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Primary sources',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        reference_documents: [
          {
            title: 'Speech Packet',
            mime_type: 'application/pdf',
            data_url: 'data:application/pdf;base64,JVBERi0xLjQK',
            size_bytes: 1234,
          },
        ],
      },
      { Cookie: cookie },
    )

    expect(created.status).toBe(201)
    expect(created.body.reference_documents).toEqual([
      expect.objectContaining({
        title: 'Speech Packet',
        mime_type: 'application/pdf',
        data_url: expect.stringContaining('data:application/pdf;base64,'),
        size_bytes: 1234,
      }),
    ])

    const config = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )

    expect(config.status).toBe(200)
    expect(config.body.assignments[0].reference_documents).toEqual([
      expect.objectContaining({
        title: 'Speech Packet',
        mime_type: 'application/pdf',
        data_url: expect.stringContaining('data:application/pdf;base64,'),
      }),
    ])
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

  it('serves the edu replay page at /edu/replay/:id', async () => {
    const res = await fetch(`${baseUrl}/edu/replay/replay:ada:hamlet`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Handtyped EDU Replay')
  })
})
