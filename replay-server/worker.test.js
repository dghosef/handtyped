import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as signDetached, randomUUID } from 'crypto'
import { gzipSync, gunzipSync } from 'zlib'
import worker from './worker.js'

function makeEnv() {
  const kv = new Map()
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
      async get(key) {
        return kv.has(key) ? kv.get(key) : null
      },
      async put(key, value) {
        kv.set(key, value)
      },
      async delete(key) {
        kv.delete(key)
      },
      async list({ prefix } = {}) {
        return {
          keys: [...kv.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({ name })),
        }
      },
    },
  }
}

async function loginTeacher(env) {
  const res = await worker.fetch(
    new Request('https://edu.handtyped.app/api/edu/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'teacher@edu.handtyped.app',
        access_code: 'handtyped-edu',
      }),
    }),
    env,
  )
  const cookie = res.headers.get('set-cookie')
  return { res, cookie }
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

  it('serves the edu landing page on edu.handtyped.app', async () => {
    const res = await worker.fetch(new Request('https://edu.handtyped.app/', { method: 'GET' }), makeEnv())

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/edu/index.html')
  })

  it('serves the teacher app shell on edu.handtyped.app/app', async () => {
    const res = await worker.fetch(new Request('https://edu.handtyped.app/app', { method: 'GET' }), makeEnv())

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/edu/app.html')
  })

  it('serves the edu replay page on edu.handtyped.app/edu/replay/:id', async () => {
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/edu/replay/replay:ada:hamlet', { method: 'GET' }),
      makeEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/edu/replay.html')
  })

  it('serves the edu dashboard api on edu.handtyped.app', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/dashboard', { method: 'GET', headers: { Cookie: cookie } }),
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      product: { host: 'edu.handtyped.app', teacher_surface: 'web', student_surface: 'native' },
      summary: { classrooms: 2, assignments: 2, live_sessions: 2 },
    })
  })

  it('serves the edu login page', async () => {
    const res = await worker.fetch(new Request('https://edu.handtyped.app/login', { method: 'GET' }), makeEnv())

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/edu/login.html')
  })

  it('returns unauthenticated teacher session by default', async () => {
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/session', { method: 'GET' }),
      makeEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ authenticated: false })
  })

  it('signs in a teacher with email and access code', async () => {
    const env = makeEnv()
    const { res, cookie } = await loginTeacher(env)

    expect(res.status).toBe(200)
    expect(cookie).toContain('edu_teacher_session=')
    expect(await res.json()).toMatchObject({
      authenticated: true,
      teacher_email: 'teacher@edu.handtyped.app',
    })
  })

  it('creates classrooms for authenticated teacher sessions', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'AP Lit', teacher_name: 'Ms. Keating', join_code: 'APLIT1' }),
      }),
      env,
    )

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'AP Lit', teacher_name: 'Ms. Keating', join_code: 'APLIT1' })
  })

  it('returns student config for a classroom join code', async () => {
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/student/config?join_code=P1EN11', { method: 'GET' }),
      makeEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      classroom: { join_code: 'P1EN11' },
      assignments: [{ classroom_id: 'period-1' }],
    })
  })

  it('stores and returns edu replay records for authenticated teachers', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const create = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/replays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'edu_replay_test',
          live_session_id: 'student:assignment',
          assignment_id: 'assignment',
          assignment_title: 'Timed essay',
          course: 'English',
          student_name: 'Test Student',
          current_text: 'Draft text',
          document_history: [{ op: 'insert', text: 'Draft text' }],
          url_history: [],
          violations: [],
        }),
      }),
      env,
    )

    expect(create.status).toBe(201)

    const read = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/replays/edu_replay_test', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )

    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      id: 'edu_replay_test',
      student_name: 'Test Student',
      assignment_title: 'Timed essay',
    })
  })

  it('supports teacher classroom creation and student join config round-trip', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const classroom = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          name: 'Period 5',
          teacher_name: 'Ms. Alvarez',
          join_code: 'P5ENG',
        }),
      }),
      env,
    )
    expect(classroom.status).toBe(201)
    const createdClassroom = await classroom.json()

    const assignment = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          title: 'Poetry response',
          course: 'English',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: 'Respond to the assigned poem.',
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)

    const config = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/student/config?join_code=P5ENG', {
        method: 'GET',
      }),
      env,
    )
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({
      classroom: { join_code: 'P5ENG', name: 'Period 5' },
      assignments: [{ title: 'Poetry response', classroom_id: createdClassroom.id }],
    })
  })

  it('deletes a class and its assignments for authenticated teachers', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          name: 'Delete Period',
          teacher_name: 'Ms. Alvarez',
          join_code: 'DEL111',
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()

    await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          title: 'Delete this assignment',
          course: 'English',
          classroom_id: classroom.id,
          classroom_name: classroom.name,
          prompt: 'Temporary assignment.',
        }),
      }),
      env,
    )

    const deleted = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/classrooms/${classroom.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(deleted.status).toBe(200)

    const config = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/student/config?join_code=DEL111', {
        method: 'GET',
      }),
      env,
    )
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({
      classroom: null,
      assignments: [],
    })
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
