import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync, sign as signDetached, randomUUID } from 'crypto'
import { gzipSync, gunzipSync } from 'zlib'
import worker from './worker.js'

const TEST_TEACHER_EMAIL = 'actual-teacher@edu.handtyped.app'
const TEST_TEACHER_PASSWORD = 'actual-teacher-password'

function makeEnv() {
  const kv = new Map()
  return {
    __kv: kv,
    REPLAY_TRUSTED_SIGNER_KEYS: '',
    REPLAY_UPLOAD_RATE_LIMIT_COUNT: '',
    REPLAY_UPLOAD_RATE_LIMIT_WINDOW_MS: '',
    EDU_GOOGLE_CLIENT_ID: 'test-google-client-id',
    __googleTokenVerifier: async (credential) => {
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

async function ensurePasswordTeacher(env) {
  const res = await worker.fetch(
    new Request('https://edu.handtyped.app/api/edu/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Actual Teacher',
        email: TEST_TEACHER_EMAIL,
        password: TEST_TEACHER_PASSWORD,
      }),
    }),
    env,
  )
  if (res.status !== 201 && res.status !== 400) {
    throw new Error(`Could not create test teacher account: ${res.status}`)
  }
}

async function loginTeacher(env) {
  await ensurePasswordTeacher(env)
  const res = await worker.fetch(
    new Request('https://edu.handtyped.app/api/edu/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'password',
        email: TEST_TEACHER_EMAIL,
        password: TEST_TEACHER_PASSWORD,
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

function signedEnvelope(keyPair = generateKeyPairSync('ed25519'), payloadOverrides = {}) {
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
  it('runs scheduled edu maintenance without throwing', async () => {
    const env = makeEnv()
    const jobs = []
    await worker.scheduled(
      { cron: '*/15 * * * *', scheduledTime: Date.now() },
      env,
      {
        waitUntil(promise) {
          jobs.push(promise)
        },
      },
    )

    await Promise.all(jobs)
    expect(jobs.length).toBe(1)
  })

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
      summary: { classrooms: 0, assignments: 0, live_sessions: 0 },
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

  it('publishes Google auth config for the teacher login page', async () => {
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/config', { method: 'GET' }),
      makeEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      auth: {
        password_enabled: true,
        google_enabled: true,
        google_client_id: 'test-google-client-id',
      },
    })
  })

  it('signs in a teacher with email and access code', async () => {
    const env = makeEnv()
    const { res, cookie } = await loginTeacher(env)

    expect(res.status).toBe(200)
    expect(cookie).toContain('edu_teacher_session=')
    expect(await res.json()).toMatchObject({
      authenticated: true,
      teacher_email: TEST_TEACHER_EMAIL,
      provider: 'password',
    })
  })

  it('rejects the old shared teacher credentials when no account exists', async () => {
    const env = makeEnv()
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'password',
          email: 'teacher@edu.handtyped.app',
          password: 'handtyped-edu',
        }),
      }),
      env,
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      authenticated: false,
      error: 'Invalid teacher login',
    })
  })

  it('creates a teacher account with email and password', async () => {
    const env = makeEnv()
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Ms. Signup',
          email: 'signup-teacher@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )

    expect(res.status).toBe(201)
    const cookie = res.headers.get('set-cookie') || ''
    expect(cookie).toContain('edu_teacher_session=')
    const signupBody = await res.json()
    expect(signupBody).toMatchObject({
      authenticated: true,
      teacher_email: 'signup-teacher@edu.handtyped.app',
      provider: 'password',
    })
    expect(signupBody.tenant_id).toMatch(/^tenant_/)
    expect(signupBody.tenant_id).not.toBe('tenant_demo')

    const dashboard = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/dashboard', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(dashboard.status).toBe(200)
    expect(await dashboard.json()).toMatchObject({
      classrooms: [],
      assignments: [],
    })

    const classrooms = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(classrooms.status).toBe(200)
    expect(await classrooms.json()).toEqual([])

    const login = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'password',
          email: 'signup-teacher@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )
    expect(login.status).toBe(200)
  })

  it('rejects duplicate teacher signup emails', async () => {
    const env = makeEnv()
    const first = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Teacher',
          email: 'duplicate-teacher@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )
    expect(first.status).toBe(201)

    const duplicate = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Teacher Again',
          email: 'duplicate-teacher@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )

    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({
      authenticated: false,
      error: 'A teacher account with that email already exists',
    })
  })

  it('repairs pre-existing non-default teachers that were accidentally placed in the demo tenant', async () => {
    const env = makeEnv()
    const signup = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Tenant Repair',
          email: 'tenant-repair@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )
    expect(signup.status).toBe(201)
    const signupBody = await signup.json()
    const teacherKey = `edu:teachers:${signupBody.teacher_id}`
    const storedTeacher = JSON.parse(env.__kv.get(teacherKey))
    env.__kv.set(teacherKey, JSON.stringify({ ...storedTeacher, tenant_id: 'tenant_demo' }))

    const login = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'password',
          email: 'tenant-repair@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie') || ''
    const loginBody = await login.json()
    expect(loginBody.tenant_id).toMatch(/^tenant_/)
    expect(loginBody.tenant_id).not.toBe('tenant_demo')

    const repairedTeacher = JSON.parse(env.__kv.get(teacherKey))
    expect(repairedTeacher.tenant_id).toBe(loginBody.tenant_id)

    const dashboard = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/dashboard', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(dashboard.status).toBe(200)
    expect(await dashboard.json()).toMatchObject({
      classrooms: [],
      assignments: [],
    })
  })

  it('refreshes stale session tenants from the current teacher record', async () => {
    const env = makeEnv()
    const signup = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Session Repair',
          email: 'session-repair@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )
    expect(signup.status).toBe(201)
    const cookie = signup.headers.get('set-cookie') || ''
    const signupBody = await signup.json()
    const teacherKey = `edu:teachers:${signupBody.teacher_id}`
    const storedTeacher = JSON.parse(env.__kv.get(teacherKey))
    env.__kv.set(teacherKey, JSON.stringify({ ...storedTeacher, tenant_id: 'tenant_session_repaired' }))

    const session = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/session', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      authenticated: true,
      tenant_id: 'tenant_session_repaired',
      teacher_email: 'session-repair@edu.handtyped.app',
    })
  })

  it('rejects duplicate classroom join codes across teacher accounts', async () => {
    const env = makeEnv()
    const firstSignup = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'First Teacher',
          email: 'first-join-code@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )
    expect(firstSignup.status).toBe(201)
    const firstCookie = firstSignup.headers.get('set-cookie') || ''

    const secondSignup = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Second Teacher',
          email: 'second-join-code@edu.handtyped.app',
          password: 'longenoughpassword',
        }),
      }),
      env,
    )
    expect(secondSignup.status).toBe(201)
    const secondCookie = secondSignup.headers.get('set-cookie') || ''

    const joinCode = `GLOBAL${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`
    const firstClassroom = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
        body: JSON.stringify({ name: 'First Join Code', join_code: joinCode }),
      }),
      env,
    )
    expect(firstClassroom.status).toBe(201)

    const duplicateClassroom = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
        body: JSON.stringify({ name: 'Second Join Code', join_code: joinCode.toLowerCase() }),
      }),
      env,
    )
    expect(duplicateClassroom.status).toBe(409)
    expect(await duplicateClassroom.json()).toMatchObject({
      error: 'Join code already in use',
      join_code: joinCode,
    })
  })

  it('signs in a teacher with Google', async () => {
    const env = makeEnv()
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          credential: 'valid-google-credential',
        }),
      }),
      env,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') || '').toContain('edu_teacher_session=')
    expect(await res.json()).toMatchObject({
      authenticated: true,
      teacher_email: 'teacher@edu.handtyped.app',
      provider: 'google',
    })
  })

  it('creates a private teacher account from a verified Google login when no teacher exists yet', async () => {
    const env = makeEnv()
    const res = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          credential: 'new-google-teacher-credential',
        }),
      }),
      env,
    )

    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') || ''
    expect(cookie).toContain('edu_teacher_session=')
    const body = await res.json()
    expect(body).toMatchObject({
      authenticated: true,
      teacher_email: 'new-google-teacher@edu.handtyped.app',
      teacher_name: 'New Google Teacher',
      provider: 'google',
    })
    expect(body.tenant_id).toMatch(/^tenant_/)
    expect(body.tenant_id).not.toBe('tenant_demo')

    const dashboard = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/dashboard', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(dashboard.status).toBe(200)
    expect(await dashboard.json()).toMatchObject({
      classrooms: [],
      assignments: [],
    })
  })

  it('rejects a different Google subject for the same teacher email once linked', async () => {
    const env = makeEnv()
    const first = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          credential: 'valid-google-credential',
        }),
      }),
      env,
    )
    expect(first.status).toBe(200)

    const second = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          credential: 'valid-google-credential-2',
        }),
      }),
      env,
    )

    expect(second.status).toBe(401)
    expect(await second.json()).toMatchObject({
      authenticated: false,
      error: 'Invalid teacher login',
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

  it('serves student launcher realtime and publishes assignment invalidations to it', async () => {
    const env = makeEnv()
    const realtimeRequests = []
    env.EDU_REALTIME = {
      idFromName(name) {
        return name
      },
      get() {
        return {
          async fetch(input, init = {}) {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            if (init.method === 'POST') {
              realtimeRequests.push({
                url,
                body: JSON.parse(init.body || '{}'),
              })
              return new Response(JSON.stringify({ delivered: 1 }))
            }
            realtimeRequests.push({ url })
            return new Response('event: ready\ndata: {}\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            })
          },
        }
      },
    }
    const { cookie } = await loginTeacher(env)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Realtime Launcher', join_code: 'RTL123' }),
      }),
      env,
    )
    expect(classroomRes.status).toBe(201)
    const classroom = await classroomRes.json()

    const subscribe = await worker.fetch(
      new Request(
        'https://edu.handtyped.app/api/edu/student/bootstrap/realtime?join_code=RTL123&student_name=Ada%20Lovelace',
      ),
      env,
    )
    expect(subscribe.status).toBe(200)
    expect(realtimeRequests.at(-1).url).toContain(
      `channel=student-bootstrap%3A${encodeURIComponent(classroom.tenant_id)}%3A${encodeURIComponent(classroom.id)}`,
    )

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Realtime Assignment',
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    expect(assignmentRes.status).toBe(201)
    const assignment = await assignmentRes.json()
    const publish = realtimeRequests.find(
      (item) => item.body?.event === 'student-bootstrap-invalidated',
    )
    expect(publish?.body).toMatchObject({
      channels: [`student-bootstrap:${classroom.tenant_id}:${classroom.id}`],
      event: 'student-bootstrap-invalidated',
      payload: {
        classroom_id: classroom.id,
        assignment_id: assignment.id,
        reason: 'assignment-created',
      },
    })
  })

  it('generates unused classroom join codes when teachers leave them blank', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const first = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Generated Code', teacher_name: 'Ms. Keating' }),
      }),
      env,
    )
    expect(first.status).toBe(201)
    const firstClassroom = await first.json()
    expect(firstClassroom.join_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(firstClassroom.join_code).not.toBe('JOINME')

    const second = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Generated Blank Code', teacher_name: 'Ms. Keating', join_code: '   ' }),
      }),
      env,
    )
    expect(second.status).toBe(201)
    const secondClassroom = await second.json()
    expect(secondClassroom.join_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(secondClassroom.join_code).not.toBe(firstClassroom.join_code)
    expect(secondClassroom.join_code).not.toBe('JOINME')
  })

  it('rejects duplicate classroom join codes case-insensitively', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const first = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'AP Lit', teacher_name: 'Ms. Keating', join_code: 'APLIT1' }),
      }),
      env,
    )
    expect(first.status).toBe(201)

    const duplicate = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'AP Lang', teacher_name: 'Ms. Keating', join_code: 'aplit1' }),
      }),
      env,
    )

    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({
      error: 'Join code already in use',
      join_code: 'APLIT1',
    })
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

  it('reflects assignment create, update, and delete changes in student config', async () => {
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
          name: 'Realtime Period',
          teacher_name: 'Ms. Alvarez',
          join_code: 'REAL22',
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
          title: 'Initial response',
          course: 'English',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: 'Write the first response.',
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)
    const createdAssignment = await assignment.json()

    const initialConfig = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/student/config?join_code=REAL22', {
        method: 'GET',
      }),
      env,
    )
    expect(initialConfig.status).toBe(200)
    expect(await initialConfig.json()).toMatchObject({
      classroom: { join_code: 'REAL22', name: 'Realtime Period' },
      assignments: [
        {
          id: createdAssignment.id,
          title: 'Initial response',
          prompt: 'Write the first response.',
        },
      ],
    })

    const updatedWindows = [
      {
        label: 'Updated window',
        days: {
          monday: true,
          tuesday: true,
          wednesday: false,
          thursday: false,
          friday: true,
          saturday: false,
          sunday: false,
        },
        end_date: '2026-05-30',
        start_hour: 13,
        start_minute: 0,
        end_hour: 14,
        end_minute: 30,
      },
    ]

    const updatedAssignment = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${createdAssignment.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          title: 'Revised response',
          prompt: 'Write the revised response.',
          windows: updatedWindows,
        }),
      }),
      env,
    )
    expect(updatedAssignment.status).toBe(200)
    expect(await updatedAssignment.json()).toMatchObject({
      id: createdAssignment.id,
      title: 'Revised response',
      prompt: 'Write the revised response.',
      windows: updatedWindows,
    })

    const updatedConfig = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/student/config?join_code=REAL22', {
        method: 'GET',
      }),
      env,
    )
    expect(updatedConfig.status).toBe(200)
    expect(await updatedConfig.json()).toMatchObject({
      classroom: { join_code: 'REAL22', name: 'Realtime Period' },
      assignments: [
        {
          id: createdAssignment.id,
          title: 'Revised response',
          prompt: 'Write the revised response.',
          windows: updatedWindows,
        },
      ],
    })

    const deletedAssignment = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${createdAssignment.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(deletedAssignment.status).toBe(200)
    expect(await deletedAssignment.json()).toMatchObject({
      deleted: true,
      assignment_id: createdAssignment.id,
    })

    const deletedConfig = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/student/config?join_code=REAL22', {
        method: 'GET',
      }),
      env,
    )
    expect(deletedConfig.status).toBe(200)
    expect(await deletedConfig.json()).toMatchObject({
      classroom: { join_code: 'REAL22', name: 'Realtime Period' },
      assignments: [],
    })
  })

  it('preserves teacher inline review data across later live-session sync updates', async () => {
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
          name: 'Review Writing',
          teacher_name: 'Ms. Alvarez',
          join_code: 'REV22',
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
          title: 'Live feedback essay',
          course: 'English',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: 'Draft and revise with teacher comments.',
          policy: { allow_offline_editing: false },
          rubric: [
            { id: 'claim', title: 'Claim', description: 'Clear argument', points: 4 },
            { id: 'evidence', title: 'Evidence', description: 'Specific support', points: 4 },
          ],
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)
    const createdAssignment = await assignment.json()

    const liveSessionId = 'review:student'
    const initialLive = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          assignment_id: createdAssignment.id,
          assignment_title: createdAssignment.title,
          course: createdAssignment.course,
          classroom: createdClassroom.name,
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
        }),
      }),
      env,
    )
    expect(initialLive.status).toBe(201)
    const initialLiveBody = await initialLive.clone().json()
    expect(initialLiveBody.tenant_id).toBe(createdAssignment.tenant_id)
    env.__kv.set(
      `${'edu:live_sessions:'}${liveSessionId}`,
      JSON.stringify({ ...initialLiveBody, tenant_id: 'legacy-default-tenant' }),
    )

    const draftGrading = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-sessions/${liveSessionId}/grading`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          teacher_comment: 'Draft-only feedback.',
          inline_annotations: [],
          publish_feedback: false,
        }),
      }),
      env,
    )
    expect(draftGrading.status).toBe(200)
    expect((await draftGrading.json()).grading).toMatchObject({
      teacher_comment: 'Draft-only feedback.',
      feedback_status: 'draft',
    })
    const draftStudentAssignment = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/assignments/${encodeURIComponent(createdAssignment.id)}?join_code=${encodeURIComponent(createdClassroom.join_code)}&student_name=${encodeURIComponent('Ada')}`,
      ),
      env,
    )
    expect(draftStudentAssignment.status).toBe(200)
    expect((await draftStudentAssignment.json()).assignment.student_feedback).toBeNull()

    const grading = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-sessions/${liveSessionId}/grading`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          rubric_scores: { claim: 3, evidence: 4 },
          teacher_comment: 'Push the thesis one step further.',
          returned_for_revision: true,
          grade_label: 'A-',
          grade_score: 91,
          inline_annotations: [
            {
              id: 'comment-1',
              type: 'comment',
              start: 0,
              end: 14,
              quote: 'Hamlet delays',
              note: 'Clarify what kind of delay this is.',
            },
            {
              id: 'suggestion-1',
              type: 'suggestion',
              start: 15,
              end: 22,
              quote: 'because',
              replacement: 'since',
              note: 'Try a tighter connector here.',
            },
          ],
        }),
      }),
      env,
    )
    expect(grading.status).toBe(200)
    expect(await grading.json()).toMatchObject({
      grading: {
        grade_label: 'A-',
        grade_score: 91,
        returned_for_revision: true,
        inline_annotations: [
          expect.objectContaining({ type: 'comment', quote: 'Hamlet delays' }),
          expect.objectContaining({ type: 'suggestion', replacement: 'since' }),
        ],
      },
    })

    const resolution = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/assignments/${encodeURIComponent(createdAssignment.id)}/feedback-resolutions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            join_code: createdClassroom.join_code,
            student_name: 'Ada',
            annotation_key: 'id:comment-1',
          }),
        },
      ),
      env,
    )
    expect(resolution.status).toBe(200)

    const studentAssignment = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/assignments/${encodeURIComponent(createdAssignment.id)}?join_code=${encodeURIComponent(createdClassroom.join_code)}&student_name=${encodeURIComponent('Ada')}`,
      ),
      env,
    )
    expect(studentAssignment.status).toBe(200)
    expect((await studentAssignment.json()).assignment).toMatchObject({
      student_feedback: expect.objectContaining({
        teacher_comment: 'Push the thesis one step further.',
        grade_label: 'A-',
        returned_for_revision: true,
        inline_annotations: expect.arrayContaining([
          expect.objectContaining({
            id: 'comment-1',
            resolved_by_student: true,
            resolved_by: 'Ada',
          }),
          expect.objectContaining({
            id: 'suggestion-1',
            resolved_by_student: false,
          }),
        ]),
      }),
    })

    const accidentalEmptySave = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-sessions/${liveSessionId}/grading`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          rubric_scores: {},
          teacher_comment: '',
          returned_for_revision: false,
          grade_label: '',
          grade_score: null,
          inline_annotations: [],
        }),
      }),
      env,
    )
    expect(accidentalEmptySave.status).toBe(200)
    expect((await accidentalEmptySave.json()).grading).toMatchObject({
      teacher_comment: 'Push the thesis one step further.',
      inline_annotations: [
        expect.objectContaining({ note: 'Clarify what kind of delay this is.' }),
        expect.objectContaining({ replacement: 'since' }),
      ],
    })

    const studentSyncUpdate = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          assignment_id: createdAssignment.id,
          assignment_title: createdAssignment.title,
          course: createdAssignment.course,
          classroom: createdClassroom.name,
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
        }),
      }),
      env,
    )
    expect(studentSyncUpdate.status).toBe(201)
    expect(await studentSyncUpdate.json()).toMatchObject({
      grading: {
        grade_label: 'A-',
        teacher_comment: 'Push the thesis one step further.',
      },
    })

    const persisted = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-sessions/${liveSessionId}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(persisted.status).toBe(200)
    expect(await persisted.json()).toMatchObject({
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

    const intentionalEmptySave = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-sessions/${liveSessionId}/grading`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          rubric_scores: {},
          teacher_comment: '',
          returned_for_revision: false,
          grade_label: '',
          grade_score: null,
          inline_annotations: [],
          allow_empty_feedback: true,
        }),
      }),
      env,
    )
    expect(intentionalEmptySave.status).toBe(200)
    expect((await intentionalEmptySave.json()).grading).toMatchObject({
      teacher_comment: '',
      inline_annotations: [],
    })
  })

  it('saves grading when the review selection points at a live replay head without a live-session row', async () => {
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
          name: 'Replay Review',
          teacher_name: 'Ms. Alvarez',
          join_code: 'HEAD22',
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
          title: 'Replay-only feedback',
          course: 'English',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: 'Review a captured replay.',
          policy: { allow_offline_editing: false },
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)
    const createdAssignment = await assignment.json()

    env.__kv.set(
      'edu:live_replay_heads:replay-head-only',
      JSON.stringify({
        id: 'replay-head-only',
        tenant_id: createdAssignment.tenant_id,
        live_session_id: 'missing-live-session',
        assignment_id: createdAssignment.id,
        assignment_title: createdAssignment.title,
        course: createdAssignment.course,
        classroom: createdClassroom.name,
        student_name: 'Ada',
        current_text: 'Selected draft',
        document_history: [{ op: 'insert', text: 'Selected draft' }],
        url_history: [],
        last_activity_at: '2026-05-02T17:00:00.000Z',
        focused: true,
        hid_active: true,
        updated_at: '2026-05-02T17:00:00.000Z',
      }),
    )

    const grading = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions/replay-head-only/grading', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          teacher_comment: 'Replay feedback.',
          inline_annotations: [
            {
              type: 'comment',
              start: 0,
              end: 8,
              quote: 'Selected',
              note: 'Clarify this opening.',
            },
          ],
        }),
      }),
      env,
    )
    expect(grading.status).toBe(200)
    expect(await grading.json()).toMatchObject({
      id: 'missing-live-session',
      assignment_id: createdAssignment.id,
      grading: {
        teacher_comment: 'Replay feedback.',
        inline_annotations: [expect.objectContaining({ note: 'Clarify this opening.' })],
      },
    })

    const studentAssignment = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/assignments/${encodeURIComponent(createdAssignment.id)}?join_code=${encodeURIComponent(createdClassroom.join_code)}&student_name=${encodeURIComponent('Ada')}`,
      ),
      env,
    )
    expect(studentAssignment.status).toBe(200)
    expect((await studentAssignment.json()).assignment).toMatchObject({
      student_feedback: expect.objectContaining({
        teacher_comment: 'Replay feedback.',
        inline_annotations: [expect.objectContaining({ note: 'Clarify this opening.' })],
      }),
    })
  })

  it('saves grading from the teacher snapshot when no stored review session exists yet', async () => {
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
          name: 'Snapshot Review',
          teacher_name: 'Ms. Alvarez',
          join_code: 'SNAP22',
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
          title: 'Snapshot feedback',
          course: 'English',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: 'Review a teacher-held snapshot.',
          policy: { allow_offline_editing: false },
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)
    const createdAssignment = await assignment.json()

    const grading = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions/not-stored-yet/grading', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          session_snapshot: {
            id: 'not-stored-yet',
            assignment_id: createdAssignment.id,
            assignment_title: createdAssignment.title,
            course: createdAssignment.course,
            classroom: createdClassroom.name,
            student_name: 'Ada',
            current_text: 'Selected draft',
            document_history: [{ op: 'insert', text: 'Selected draft' }],
            last_activity_at: '2026-05-02T17:00:00.000Z',
            schedule_open: true,
            focused: true,
            hid_active: true,
          },
          teacher_comment: 'Snapshot feedback.',
          inline_annotations: [
            {
              type: 'comment',
              start: 0,
              end: 8,
              quote: 'Selected',
              note: 'Persist this snapshot comment.',
            },
          ],
        }),
      }),
      env,
    )
    expect(grading.status).toBe(200)
    expect(await grading.json()).toMatchObject({
      id: 'not-stored-yet',
      assignment_id: createdAssignment.id,
      grading: {
        teacher_comment: 'Snapshot feedback.',
        inline_annotations: [expect.objectContaining({ note: 'Persist this snapshot comment.' })],
      },
    })
  })

  it('keeps ordinary live typing updates out of replay history until replay capture is explicitly requested', async () => {
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
          name: 'Live Replay Gating',
          teacher_name: 'Ms. Torres',
          join_code: 'GATE22',
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
          title: 'Live replay gating',
          course: 'English',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: 'Type live without turning every keystroke into replay history.',
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)
    const createdAssignment = await assignment.json()

    const liveSessionId = 'Ada:replay-gating-student'
    const liveOnlyPublish = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          assignment_id: createdAssignment.id,
          assignment_title: createdAssignment.title,
          course: createdAssignment.course,
          classroom: createdClassroom.name,
          student_name: 'Ada',
          current_text: 'Teacher should still see this instantly.',
          document_history: [{ t: 1, ins: 'Teacher should still see this instantly.', del: '', pos: 0 }],
          focus_events: [{ t: 1, state: 'focused' }],
          url_history: [],
          violation_count: 0,
          violations: [],
          last_activity_at: '2026-04-27T12:00:00Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
          updated_at: '2026-04-27T12:00:00Z',
        }),
      }),
      env,
    )
    expect(liveOnlyPublish.status).toBe(201)

    const liveOnlyReplayUpdates = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(liveOnlyReplayUpdates.status).toBe(404)

    const liveOnlyReplayFallback = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-replays/${encodeURIComponent(liveSessionId)}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(liveOnlyReplayFallback.status).toBe(200)
    expect(await liveOnlyReplayFallback.json()).toMatchObject({
      id: liveSessionId,
      current_text: 'Teacher should still see this instantly.',
      events: [],
    })

    const liveOnlyStoredReplayFallback = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/replays/replay:${encodeURIComponent(liveSessionId)}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(liveOnlyStoredReplayFallback.status).toBe(200)
    expect(await liveOnlyStoredReplayFallback.json()).toMatchObject({
      id: `replay:${liveSessionId}`,
      live_session_id: liveSessionId,
      current_text: 'Teacher should still see this instantly.',
      document_history: [{ t: 1, ins: 'Teacher should still see this instantly.', del: '', pos: 0 }],
    })

    const replayCapturePublish = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          assignment_id: createdAssignment.id,
          assignment_title: createdAssignment.title,
          course: createdAssignment.course,
          classroom: createdClassroom.name,
          student_name: 'Ada',
          current_text: 'This update should advance replay history too.',
          document_history: [{ t: 2, ins: 'This update should advance replay history too.', del: '', pos: 0 }],
          focus_events: [{ t: 2, state: 'focused' }],
          url_history: [],
          violation_count: 0,
          violations: [],
          last_activity_at: '2026-04-27T12:00:05Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
          capture_replay: true,
          updated_at: '2026-04-27T12:00:05Z',
        }),
      }),
      env,
    )
    expect(replayCapturePublish.status).toBe(201)

    let replayUpdates = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      replayUpdates = await worker.fetch(
        new Request(`https://edu.handtyped.app/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates`, {
          method: 'GET',
          headers: { Cookie: cookie },
        }),
        env,
      )
      if (replayUpdates.status === 200) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(replayUpdates.status).toBe(200)
    expect(await replayUpdates.json()).toMatchObject({
      id: liveSessionId,
      current_text: 'This update should advance replay history too.',
      last_seq: 1,
      events: [expect.objectContaining({ seq: 1, current_text: 'This update should advance replay history too.' })],
    })
  })

  it('refreshes dashboard summary counts immediately after a live session publish', async () => {
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
          name: 'Live Summary',
          teacher_name: 'Ms. Rivera',
          join_code: 'SUMM22',
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
          title: 'Live summary check',
          course: 'English',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: 'Check dashboard summary updates.',
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)
    const createdAssignment = await assignment.json()

    const beforeDashboard = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/dashboard', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(beforeDashboard.status).toBe(200)
    const beforeSummary = (await beforeDashboard.json()).summary

    const publish = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'live-summary-student',
          assignment_id: createdAssignment.id,
          assignment_title: createdAssignment.title,
          course: createdAssignment.course,
          classroom: createdClassroom.name,
          student_name: 'Ada',
          current_text: 'Teacher should see me live.',
          document_history: [{ t: 1, ins: 'Teacher should see me live.', del: '', pos: 0 }],
          focus_events: [{ t: 1, state: 'focused' }],
          url_history: [],
          violation_count: 0,
          violations: [],
          last_activity_at: '2026-04-27T12:00:00Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
          updated_at: '2026-04-27T12:00:00Z',
        }),
      }),
      env,
    )
    expect(publish.status).toBe(201)

    const afterDashboard = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/dashboard', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(afterDashboard.status).toBe(200)
    const afterSummary = (await afterDashboard.json()).summary
    expect(Number(afterSummary.live_sessions || 0)).toBe(Number(beforeSummary.live_sessions || 0) + 1)
    expect(Number(afterSummary.active_students || 0)).toBe(Number(beforeSummary.active_students || 0) + 1)
  })

  it('does not block live session publishes on stalled realtime delivery', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Nonblocking Live',
          teacher_name: 'Ms. Rivera',
          join_code: 'NBLIVE',
        }),
      }),
      env,
    )
    expect(classroomRes.status).toBe(201)
    const classroom = await classroomRes.json()

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Nonblocking live publish',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    expect(assignmentRes.status).toBe(201)
    const assignment = await assignmentRes.json()

    env.EDU_REALTIME = {
      idFromName() {
        return 'hanging-realtime'
      },
      get() {
        return {
          fetch() {
            return new Promise(() => {})
          },
        }
      },
    }
    const waitUntilPromises = []
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(promise)
      },
    }

    const responseOrTimeout = await Promise.race([
      worker.fetch(
        new Request('https://edu.handtyped.app/api/edu/live-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `nonblocking:${assignment.id}:ada`,
            assignment_id: assignment.id,
            assignment_title: assignment.title,
            course: assignment.course,
            classroom: classroom.name,
            student_name: 'Ada',
            current_text: 'This publish should not wait for realtime.',
            document_history_tail: [{ t: 1, pos: 0, del: '', ins: 'This publish should not wait for realtime.' }],
            history_base_count: 0,
            history_base_t: 0,
            current_text_checkpoint: 'This publish should not wait for realtime.',
            focus_events: [],
            url_history: [],
            violation_count: 0,
            violations: [],
            last_activity_at: '2026-04-27T12:00:00Z',
            schedule_open: true,
            focused: true,
            hid_active: true,
          }),
        }),
        env,
        ctx,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ])

    expect(responseOrTimeout).not.toBe('timed-out')
    expect(responseOrTimeout.status).toBe(201)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
  })

  it('marks a live session inactive immediately when a student closes the assignment', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Close Presence',
          teacher_name: 'Ms. Rivera',
          join_code: 'CLOSE22',
        }),
      }),
      env,
    )
    expect(classroomRes.status).toBe(201)
    const classroom = await classroomRes.json()

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Close presence check',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    expect(assignmentRes.status).toBe(201)
    const assignment = await assignmentRes.json()

    const liveSessionId = `Ada:${assignment.id}`
    const publish = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          tenant_id: assignment.tenant_id,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          course: assignment.course,
          classroom: classroom.name,
          student_name: 'Ada',
          current_text: 'Closing should clear active.',
          document_history: [{ t: 1, ins: 'Closing should clear active.', del: '', pos: 0 }],
          last_activity_at: new Date().toISOString(),
          schedule_open: true,
          focused: true,
          hid_active: true,
        }),
      }),
      env,
    )
    expect(publish.status).toBe(201)

    const close = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/student/assignments/${assignment.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          join_code: classroom.join_code,
          student_name: 'Ada',
        }),
      }),
      env,
    )
    expect(close.status).toBe(201)

    const liveSessions = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(liveSessions.status).toBe(200)
    const closedSession = (await liveSessions.json()).find((session) => session.id === liveSessionId)
    expect(closedSession).toMatchObject({
      id: liveSessionId,
      focused: false,
      schedule_open: false,
    })
  })

  it('preserves live text and history when a worker presence update is empty', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const liveSessionId = 'presence:worker-student'

    const initialPublish = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          tenant_id: 'default',
          assignment_id: 'assignment-worker',
          student_name: 'Ada',
          current_text: 'A live draft should stay visible to teachers.',
          document_history: [{ op: 'insert', text: 'A live draft should stay visible to teachers.' }],
          last_activity_at: '2026-04-28T12:00:00Z',
        }),
      }),
      env,
    )
    expect(initialPublish.status).toBe(201)

    const blankPresencePublish = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          tenant_id: 'default',
          assignment_id: 'assignment-worker',
          student_name: 'Ada',
          current_text: '',
          document_history: [],
          last_activity_at: '2026-04-28T12:01:00Z',
          focused: false,
        }),
      }),
      env,
    )
    expect(blankPresencePublish.status).toBe(201)
    expect(await blankPresencePublish.json()).toMatchObject({
      id: liveSessionId,
      current_text: 'A live draft should stay visible to teachers.',
      document_history: [{ op: 'insert', text: 'A live draft should stay visible to teachers.' }],
      focused: false,
    })

    expect(cookie).toBeTruthy()
  })

  it('rejects new suggestions while the student is still actively editing', async () => {
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
          name: 'Suggestion Safety',
          teacher_name: 'Ms. Alvarez',
          join_code: 'SAFE22',
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
          title: 'Unsafe live suggestion',
          course: 'English',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: 'Keep drafting while the window is still open.',
          policy: { allow_offline_editing: false },
          temporary_access_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)
    const createdAssignment = await assignment.json()

    const liveSessionId = 'unsafe-suggestion:student'
    const livePublish = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          assignment_id: createdAssignment.id,
          assignment_title: createdAssignment.title,
          course: createdAssignment.course,
          classroom: createdClassroom.name,
          student_name: 'Ada',
          current_text: 'A working draft is still changing.',
          document_history: [{ op: 'insert', text: 'A working draft is still changing.' }],
          current_url: null,
          current_url_title: null,
          url_history: [],
          violation_count: 0,
          violations: [],
          last_activity_at: new Date().toISOString(),
          schedule_open: true,
          focused: true,
          hid_active: true,
        }),
      }),
      env,
    )
    expect(livePublish.status).toBe(201)

    const unsafeSuggestion = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-sessions/${liveSessionId}/grading`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          teacher_comment: 'Keep pushing the idea.',
          inline_annotations: [
            {
              type: 'comment',
              start: 0,
              end: 9,
              quote: 'A working',
              note: 'Open more directly.',
            },
            {
              type: 'suggestion',
              start: 10,
              end: 15,
              quote: 'draft',
              replacement: 'claim',
              note: 'Name the argument more precisely.',
            },
          ],
        }),
      }),
      env,
    )
    expect(unsafeSuggestion.status).toBe(409)
    expect(await unsafeSuggestion.json()).toMatchObject({
      error: expect.stringContaining('Suggestions can only be added'),
    })
  })

  it('deletes assignments for authenticated teachers', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const joinCode = `DEL${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

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
          join_code: joinCode,
        }),
      }),
      env,
    )
    expect(classroomRes.status).toBe(201)
    const classroom = await classroomRes.json()

    const assignmentRes = await worker.fetch(
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
    expect(assignmentRes.status).toBe(201)
    const assignment = await assignmentRes.json()

    const deleted = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({
      deleted: true,
      assignment_id: assignment.id,
    })

    const assignments = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(assignments.status).toBe(200)
    expect(await assignments.json()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignment.id })]),
    )

    const dashboard = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/dashboard', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(dashboard.status).toBe(200)
    const dashboardBody = await dashboard.json()
    expect(dashboardBody.assignment_audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignment_id: assignment.id,
          action: 'deleted',
          assignment_title: 'Delete this assignment',
        }),
      ]),
    )
    expect(dashboardBody.assignments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignment.id })]),
    )
  })

  it('includes linked assignment ids in student config', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const joinCode = `LNK${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          name: 'Linked Period',
          teacher_name: 'Ms. Alvarez',
          join_code: joinCode,
        }),
      }),
      env,
    )
    expect(classroomRes.status).toBe(201)
    const classroom = await classroomRes.json()

    const priorAssignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          title: 'Draft one',
          course: 'English',
          classroom_id: classroom.id,
          classroom_name: classroom.name,
          prompt: 'Write your first draft.',
        }),
      }),
      env,
    )
    expect(priorAssignmentRes.status).toBe(201)
    const priorAssignment = await priorAssignmentRes.json()

    const linkedAssignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          title: 'Draft two',
          course: 'English',
          classroom_id: classroom.id,
          classroom_name: classroom.name,
          prompt: 'Revise with access to your first draft.',
          linked_assignment_ids: [priorAssignment.id],
        }),
      }),
      env,
    )
    expect(linkedAssignmentRes.status).toBe(201)
    const linkedAssignment = await linkedAssignmentRes.json()

    const studentConfig = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}`, {
        method: 'GET',
      }),
      env,
    )
    expect(studentConfig.status).toBe(200)
    expect((await studentConfig.json()).assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: linkedAssignment.id,
          linked_assignment_ids: [priorAssignment.id],
        }),
      ]),
    )
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

  it('allows creating assignments without an essay prompt', async () => {
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
          name: 'Independent Reading',
          teacher_name: 'Ms. Alvarez',
          join_code: 'NOPROM',
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
          title: 'Reading notes',
          course: 'Independent Reading',
          classroom_id: createdClassroom.id,
          classroom_name: createdClassroom.name,
          prompt: '',
        }),
      }),
      env,
    )
    expect(assignment.status).toBe(201)
    expect(await assignment.json()).toMatchObject({
      title: 'Reading notes',
      prompt: '',
    })

    const config = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/student/config?join_code=NOPROM', {
        method: 'GET',
      }),
      env,
    )
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({
      classroom: { join_code: 'NOPROM', name: 'Independent Reading' },
      assignments: [
        {
          title: 'Reading notes',
          prompt: '',
        },
      ],
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

  it('accepts FIFO keyboard transports for trusted signers', async () => {
    const trustedSignerKeyPair = generateKeyPairSync('ed25519')
    const trustedEnv = {
      ...makeEnv(),
      REPLAY_TRUSTED_SIGNER_KEYS: publicKeyHex(trustedSignerKeyPair),
    }

    const res = await worker.fetch(
      new Request('https://replay.handtyped.app/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          signedEnvelope(trustedSignerKeyPair, { keyboard_transport: 'FIFO' }),
        ),
      }),
      trustedEnv,
    )

    expect(res.status).toBe(200)
  })

  it('rejects non-built-in keyboard transports even for trusted signers', async () => {
    const trustedSignerKeyPair = generateKeyPairSync('ed25519')
    const trustedEnv = {
      ...makeEnv(),
      REPLAY_TRUSTED_SIGNER_KEYS: publicKeyHex(trustedSignerKeyPair),
    }

    const res = await worker.fetch(
      new Request('https://replay.handtyped.app/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          signedEnvelope(trustedSignerKeyPair, { keyboard_transport: 'USB' }),
        ),
      }),
      trustedEnv,
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'Replay uploads require trusted built-in keyboard transport (SPI or FIFO)',
    })
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

describe('worker per-student assignment extensions', () => {
  it('returns a personalized temporary access deadline for the matching student only', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const joinCode = `EXT${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Extensions',
          teacher_name: 'Joseph Tan',
          join_code: joinCode,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Timed Write',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
          temporary_access_until: '2026-04-27T18:00:00.000Z',
          student_temporary_access_until: {
            'ada lovelace': '2026-04-27T19:30:00.000Z',
          },
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    const adaRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
        { method: 'GET' },
      ),
      env,
    )
    const graceRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
        { method: 'GET' },
      ),
      env,
    )

    expect(adaRes.status).toBe(200)
    expect(await adaRes.json()).toMatchObject({
      assignments: [
        {
          id: assignment.id,
          temporary_access_until: '2026-04-27T19:30:00.000Z',
          student_temporary_access_until: {},
        },
      ],
    })
    expect(graceRes.status).toBe(200)
    expect(await graceRes.json()).toMatchObject({
      assignments: [
        {
          id: assignment.id,
          temporary_access_until: '2026-04-27T18:00:00.000Z',
          student_temporary_access_until: {},
        },
      ],
    })
  })

  it('stores student access requests and clears them when a teacher approves closed access', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const joinCode = `REQ${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'After Hours',
          teacher_name: 'Joseph Tan',
          join_code: joinCode,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Exit Ticket',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    const accessRequestRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}/access-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_name: 'Ada Lovelace' }),
      }),
      env,
    )
    expect(accessRequestRes.status).toBe(201)

    const teacherReadRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(teacherReadRes.status).toBe(200)
    expect(await teacherReadRes.json()).toMatchObject({
      student_access_requests: {
        'ada lovelace': {
          student_name: 'Ada Lovelace',
        },
      },
    })

    const feedbackRequestRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}/feedback-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_name: 'Ada Lovelace', note: 'Can you review my ending?' }),
      }),
      env,
    )
    expect(feedbackRequestRes.status).toBe(201)
    expect(await feedbackRequestRes.json()).toMatchObject({
      student_feedback_request: {
        student_name: 'Ada Lovelace',
        note: 'Can you review my ending?',
      },
    })

    const teacherFeedbackReadRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(teacherFeedbackReadRes.status).toBe(200)
    expect(await teacherFeedbackReadRes.json()).toMatchObject({
      student_feedback_requests: {
        'ada lovelace': {
          student_name: 'Ada Lovelace',
        },
      },
    })

    const approvedUntil = '2026-04-28T18:30:00.000Z'
    const approveRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          student_access_requests: {},
          student_temporary_access_until: {
            'ada lovelace': approvedUntil,
          },
        }),
      }),
      env,
    )
    expect(approveRes.status).toBe(200)

    const studentConfigRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
        { method: 'GET' },
      ),
      env,
    )
    expect(studentConfigRes.status).toBe(200)
    expect(await studentConfigRes.json()).toMatchObject({
      assignments: [
        {
          id: assignment.id,
          temporary_access_until: approvedUntil,
          access_revoked: false,
          student_access_request: null,
        },
      ],
    })
  })

  it('keeps feedback requests through drafts, clears them on publish, and allows requesting again', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const joinCode = `FDB${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Feedback Studio',
          teacher_name: 'Joseph Tan',
          join_code: joinCode,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Revision Letter',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    const liveSessionId = `feedback:${randomUUID()}`
    const liveSessionRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          course: assignment.course,
          classroom: classroom.name,
          student_name: 'Ada Lovelace',
          current_text: 'My ending needs sharper reflection.',
          document_history: [{ op: 'insert', text: 'My ending needs sharper reflection.' }],
          current_url: null,
          current_url_title: null,
          url_history: [],
          violation_count: 0,
          violations: [],
          last_activity_at: '2026-04-27T12:00:00Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
        }),
      }),
      env,
    )
    expect(liveSessionRes.status).toBe(201)

    const feedbackRequestRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}/feedback-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_name: 'Ada Lovelace', note: 'Can you review my ending?' }),
      }),
      env,
    )
    expect(feedbackRequestRes.status).toBe(201)

    const draftGradingRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          teacher_comment: 'Draft note for my eyes only.',
          inline_annotations: [],
          publish_feedback: false,
        }),
      }),
      env,
    )
    expect(draftGradingRes.status).toBe(200)

    const assignmentAfterDraftRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(assignmentAfterDraftRes.status).toBe(200)
    expect(await assignmentAfterDraftRes.json()).toMatchObject({
      student_feedback_requests: {
        'ada lovelace': {
          student_name: 'Ada Lovelace',
          note: 'Can you review my ending?',
        },
      },
    })

    const publishedGradingRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          teacher_comment: 'Your ending is stronger when it returns to the opening image.',
          inline_annotations: [],
        }),
      }),
      env,
    )
    expect(publishedGradingRes.status).toBe(200)

    const assignmentAfterFeedbackRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(assignmentAfterFeedbackRes.status).toBe(200)
    const assignmentAfterFeedback = await assignmentAfterFeedbackRes.json()
    expect(assignmentAfterFeedback.student_feedback_requests).not.toHaveProperty('ada lovelace')

    const dashboardRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/dashboard', {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(dashboardRes.status).toBe(200)
    const dashboardAssignment = (await dashboardRes.json()).assignments.find((item) => item.id === assignment.id)
    expect(dashboardAssignment.student_feedback_requests).not.toHaveProperty('ada lovelace')

    const secondFeedbackRequestRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}/feedback-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_name: 'Ada Lovelace', note: 'Can you review my revision?' }),
      }),
      env,
    )
    expect(secondFeedbackRequestRes.status).toBe(201)
    expect(await secondFeedbackRequestRes.json()).toMatchObject({
      student_feedback_request: {
        student_name: 'Ada Lovelace',
        note: 'Can you review my revision?',
      },
    })
  })

  it('publishes feedback even when realtime dashboard delivery does not resolve', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Slow Feedback Realtime',
          teacher_name: 'Joseph Tan',
          join_code: `FBRT${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Publish Without Waiting',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    const liveSessionId = `feedback-realtime:${randomUUID()}`
    const liveSessionRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: liveSessionId,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          course: assignment.course,
          classroom: classroom.name,
          student_name: 'Ada Lovelace',
          current_text: 'Draft ready for feedback.',
          document_history: [{ op: 'insert', text: 'Draft ready for feedback.' }],
          current_url: null,
          current_url_title: null,
          url_history: [],
          violation_count: 0,
          violations: [],
          last_activity_at: '2026-04-27T12:00:00Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
        }),
      }),
      env,
    )
    expect(liveSessionRes.status).toBe(201)

    env.EDU_REALTIME = {
      idFromName() {
        return 'hanging-realtime'
      },
      get() {
        return {
          fetch() {
            return new Promise(() => {})
          },
        }
      },
    }
    const waitUntilPromises = []
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(promise)
      },
    }

    const responseOrTimeout = await Promise.race([
      worker.fetch(
        new Request(`https://edu.handtyped.app/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            teacher_comment: 'This feedback should publish without waiting for realtime.',
            inline_annotations: [],
            publish_feedback: true,
          }),
        }),
        env,
        ctx,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ])

    expect(responseOrTimeout).not.toBe('timed-out')
    expect(responseOrTimeout.status).toBe(200)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
  })

  it('clears feedback requests when dismissed or when the student submits a newer draft', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Feedback Request Lifecycle',
          teacher_name: 'Joseph Tan',
          join_code: `FRLC${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Feedback Lifecycle Essay',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    const firstRequestRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}/feedback-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_name: 'Ada Lovelace', note: 'Duplicate request.' }),
      }),
      env,
    )
    expect(firstRequestRes.status).toBe(201)

    const dismissRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/assignments/${assignment.id}/feedback-requests/${encodeURIComponent('Ada Lovelace')}`,
        {
          method: 'DELETE',
          headers: { Cookie: cookie },
        },
      ),
      env,
    )
    expect(dismissRes.status).toBe(200)
    expect(await dismissRes.json()).toMatchObject({
      assignment_id: assignment.id,
      dismissed: true,
      student_name: 'Ada Lovelace',
      student_feedback_request: null,
    })

    const requestAfterDismissRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}/feedback-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_name: 'Ada Lovelace', note: 'Please review this version.' }),
      }),
      env,
    )
    expect(requestAfterDismissRes.status).toBe(201)

    const staleLiveRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `lifecycle:${assignment.id}`,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          course: assignment.course,
          classroom: classroom.name,
          student_name: 'Ada Lovelace',
          current_text: 'Older draft sync.',
          document_history: [{ op: 'insert', text: 'Older draft sync.' }],
          last_activity_at: '2026-04-27T12:00:00.000Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
        }),
      }),
      env,
    )
    expect(staleLiveRes.status).toBe(201)
    const assignmentAfterStaleLiveRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(assignmentAfterStaleLiveRes.status).toBe(200)
    expect(await assignmentAfterStaleLiveRes.json()).toMatchObject({
      student_feedback_requests: {
        'ada lovelace': {
          student_name: 'Ada Lovelace',
          note: 'Please review this version.',
        },
      },
    })

    const newerLiveRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `lifecycle:${assignment.id}`,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          course: assignment.course,
          classroom: classroom.name,
          student_name: 'Ada Lovelace',
          current_text: 'New draft after request.',
          document_history: [{ op: 'insert', text: 'New draft after request.' }],
          last_activity_at: new Date(Date.now() + 1000).toISOString(),
          schedule_open: true,
          focused: true,
          hid_active: true,
        }),
      }),
      env,
    )
    expect(newerLiveRes.status).toBe(201)

    const assignmentAfterNewerLiveRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(assignmentAfterNewerLiveRes.status).toBe(200)
    expect((await assignmentAfterNewerLiveRes.json()).student_feedback_requests).not.toHaveProperty('ada lovelace')
  })

  it('returns access requests even when realtime publishing does not resolve', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Slow Realtime',
          teacher_name: 'Joseph Tan',
          join_code: `SLOW${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Request Without Waiting',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    env.EDU_REALTIME = {
      idFromName() {
        return 'hanging-realtime'
      },
      get() {
        return {
          fetch() {
            return new Promise(() => {})
          },
        }
      },
    }
    const waitUntilPromises = []
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(promise)
      },
    }

    const responseOrTimeout = await Promise.race([
      worker.fetch(
        new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}/access-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student_name: 'Ada Lovelace' }),
        }),
        env,
        ctx,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ])

    expect(responseOrTimeout).not.toBe('timed-out')
    expect(responseOrTimeout.status).toBe(201)
    expect(waitUntilPromises.length).toBeGreaterThan(0)

    const teacherReadRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(teacherReadRes.status).toBe(200)
    expect(await teacherReadRes.json()).toMatchObject({
      student_access_requests: {
        'ada lovelace': {
          student_name: 'Ada Lovelace',
        },
      },
    })
  })

  it('approves access requests even when realtime publishing does not resolve', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Slow Approval Realtime',
          teacher_name: 'Joseph Tan',
          join_code: `APPR${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Approve Without Waiting',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
          student_access_requests: {
            'ada lovelace': {
              student_name: 'Ada Lovelace',
              requested_at: '2026-04-28T16:00:00.000Z',
              note: '',
            },
          },
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    env.EDU_REALTIME = {
      idFromName() {
        return 'hanging-realtime'
      },
      get() {
        return {
          fetch() {
            return new Promise(() => {})
          },
        }
      },
    }
    const waitUntilPromises = []
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(promise)
      },
    }
    const approvedUntil = '2026-04-28T18:30:00.000Z'

    const responseOrTimeout = await Promise.race([
      worker.fetch(
        new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            student_access_requests: {},
            student_temporary_access_until: {
              'ada lovelace': approvedUntil,
            },
          }),
        }),
        env,
        ctx,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ])

    expect(responseOrTimeout).not.toBe('timed-out')
    expect(responseOrTimeout.status).toBe(200)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    expect(await responseOrTimeout.json()).toMatchObject({
      student_access_requests: {},
      student_temporary_access_until: {
        'ada lovelace': approvedUntil,
      },
    })
  })

  it('lets protected students rejoin in a later scheduled period', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-05-04T09:30:00-04:00'))
    try {
      const env = makeEnv()
      const { cookie } = await loginTeacher(env)
      const joinCode = `PER${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

      const classroomRes = await worker.fetch(
        new Request('https://edu.handtyped.app/api/edu/classrooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            name: 'Period Rejoin',
            teacher_name: 'Ms. Keating',
            join_code: joinCode,
          }),
        }),
        env,
      )
      const classroom = await classroomRes.json()
      expect(classroomRes.status).toBe(201)

      const assignmentRes = await worker.fetch(
        new Request('https://edu.handtyped.app/api/edu/assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            title: 'Two-period draft',
            course: classroom.name,
            classroom_id: classroom.id,
            classroom_name: classroom.name,
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
          }),
        }),
        env,
      )
      const assignment = await assignmentRes.json()
      expect(assignmentRes.status).toBe(201)

      const closeRes = await worker.fetch(
        new Request(`https://edu.handtyped.app/api/edu/student/assignments/${assignment.id}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            join_code: joinCode,
            student_name: 'Ada Lovelace',
          }),
        }),
        env,
      )
      expect(closeRes.status).toBe(201)
      expect(await closeRes.clone().json()).toMatchObject({ access_revoked: false, close_count: 1 })

      const openRes = await worker.fetch(
        new Request(`https://edu.handtyped.app/api/edu/student/assignments/${assignment.id}/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            join_code: joinCode,
            student_name: 'Ada Lovelace',
          }),
        }),
        env,
      )
      expect(openRes.status).toBe(201)

      const secondCloseRes = await worker.fetch(
        new Request(`https://edu.handtyped.app/api/edu/student/assignments/${assignment.id}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            join_code: joinCode,
            student_name: 'Ada Lovelace',
          }),
        }),
        env,
      )
      expect(secondCloseRes.status).toBe(201)
      expect(await secondCloseRes.json()).toMatchObject({ access_revoked: true, close_count: 2 })

      const blockedRes = await worker.fetch(
        new Request(
          `https://edu.handtyped.app/api/edu/student/assignments/${assignment.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
          { method: 'GET' },
        ),
        env,
      )
      expect(blockedRes.status).toBe(200)
      expect(await blockedRes.json()).toMatchObject({
        schedule_open: false,
        assignment: {
          access_revoked: true,
        },
      })

      vi.setSystemTime(new Date('2026-05-04T11:30:00-04:00'))
      const laterRes = await worker.fetch(
        new Request(
          `https://edu.handtyped.app/api/edu/student/assignments/${assignment.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
          { method: 'GET' },
        ),
        env,
      )
      expect(laterRes.status).toBe(200)
      expect(await laterRes.json()).toMatchObject({
        schedule_open: true,
        session_end_at: '2026-05-04T16:00:00.000Z',
        assignment: {
          access_revoked: false,
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces per-student instant access revocation in student config', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const joinCode = `REV${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'English 12',
          teacher_name: 'Ms. Keating',
          join_code: joinCode,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'In-class close read',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
          temporary_access_until: '2099-01-01T23:59:59.000Z',
          student_access_revoked: {
            'ada lovelace': true,
          },
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    const revokedConfigRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
        { method: 'GET' },
      ),
      env,
    )
    expect(revokedConfigRes.status).toBe(200)
    expect(await revokedConfigRes.json()).toMatchObject({
      assignments: [
        {
          id: assignment.id,
          access_revoked: true,
          student_access_revoked: {},
        },
      ],
    })

    const openConfigRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
        { method: 'GET' },
      ),
      env,
    )
    expect(openConfigRes.status).toBe(200)
    expect(await openConfigRes.json()).toMatchObject({
      assignments: [
        {
          id: assignment.id,
          access_revoked: false,
        },
      ],
    })
  })

  it('returns lightweight live summaries and direct single-assignment student config', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const joinCode = `LIV${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'English 10',
          teacher_name: 'Ms. Keating',
          join_code: joinCode,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Live Draft',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
          temporary_access_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      }),
      env,
    )
    const assignment = await assignmentRes.json()
    expect(assignmentRes.status).toBe(201)

    const linkedAssignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Earlier Draft',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    const linkedAssignment = await linkedAssignmentRes.json()
    expect(linkedAssignmentRes.status).toBe(201)

    const updatedAssignmentRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          linked_assignment_ids: [linkedAssignment.id],
        }),
      }),
      env,
    )
    expect(updatedAssignmentRes.status).toBe(200)

    const liveSessionRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `Ada Lovelace:${assignment.id}`,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          course: assignment.course,
          classroom: classroom.name,
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
        }),
      }),
      env,
    )
    expect(liveSessionRes.status).toBe(201)

    const linkedLiveSessionRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `Ada Lovelace:${linkedAssignment.id}`,
          assignment_id: linkedAssignment.id,
          assignment_title: linkedAssignment.title,
          course: linkedAssignment.course,
          classroom: classroom.name,
          student_name: 'Ada Lovelace',
          current_text: 'Earlier draft reference text',
          document_history: [{ t: 1, ins: 'Earlier', del: '', pos: 0 }],
          focus_events: [{ t: 1, state: 'focused' }],
          url_history: [],
          violation_count: 0,
          violations: [],
          last_activity_at: new Date().toISOString(),
          schedule_open: true,
          focused: true,
          hid_active: true,
          updated_at: new Date().toISOString(),
        }),
      }),
      env,
    )
    expect(linkedLiveSessionRes.status).toBe(201)

    const summariesRes = await worker.fetch(
      new Request(`https://edu.handtyped.app/api/edu/assignments/${assignment.id}/live-summaries`, {
        method: 'GET',
        headers: { Cookie: cookie },
      }),
      env,
    )
    expect(summariesRes.status).toBe(200)
    const summaries = await summariesRes.json()
    expect(summaries.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `Ada Lovelace:${assignment.id}`,
          assignment_id: assignment.id,
          current_text: 'Draft opening paragraph',
          recent_edit_count: expect.any(Number),
        }),
      ]),
    )
    expect(summaries.live_sessions[0].document_history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ins: 'Draft' }),
      ]),
    )
    expect(summaries.live_sessions[0].url_history).toHaveLength(4)

    const studentAssignmentRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/assignments/${assignment.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
        { method: 'GET' },
      ),
      env,
    )
    expect(studentAssignmentRes.status).toBe(200)
    expect(await studentAssignmentRes.json()).toMatchObject({
      classroom: {
        id: classroom.id,
      },
      assignment: {
        id: assignment.id,
        access_revoked: false,
      },
      schedule_open: expect.any(Boolean),
      session_end_at: expect.any(String),
      linked_references: [
        expect.objectContaining({
          assignment_id: linkedAssignment.id,
          available: true,
          markdown: 'Earlier draft reference text',
        }),
      ],
    })
  })

  it('shows targeted assignments only to the assigned students in the same class', async () => {
    const env = makeEnv()
    const { cookie } = await loginTeacher(env)
    const joinCode = `TAR${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'English 11',
          teacher_name: 'Joseph Tan',
          join_code: joinCode,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const wholeClassRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Whole class draft',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
        }),
      }),
      env,
    )
    const targetedRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Ada only draft',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
          assigned_students: ['Ada Lovelace'],
        }),
      }),
      env,
    )

    expect(wholeClassRes.status).toBe(201)
    expect(targetedRes.status).toBe(201)

    const adaRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
        { method: 'GET' },
      ),
      env,
    )
    const graceRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
        { method: 'GET' },
      ),
      env,
    )

    expect(adaRes.status).toBe(200)
    const adaConfig = await adaRes.json()
    expect(adaConfig.classroom.students).toEqual(['Ada Lovelace'])
    expect(adaConfig.assignments.map((assignment) => assignment.title).sort()).toEqual([
      'Ada only draft',
      'Whole class draft',
    ])

    expect(graceRes.status).toBe(200)
    const graceConfig = await graceRes.json()
    expect(graceConfig.classroom.students).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(graceConfig.assignments.map((assignment) => assignment.title).sort()).toEqual([
      'Whole class draft',
    ])
  })

  it('applies per-student setting overrides in worker student config responses', async () => {
    const env = makeEnv()
    const { res: loginRes, cookie } = await loginTeacher(env)
    const joinCode = `OVR${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`

    expect(loginRes.status).toBe(200)

    const classroomRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'English 11',
          teacher_name: 'Joseph Tan',
          join_code: joinCode,
        }),
      }),
      env,
    )
    const classroom = await classroomRes.json()
    expect(classroomRes.status).toBe(201)

    const assignmentRes = await worker.fetch(
      new Request('https://edu.handtyped.app/api/edu/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Differentiated write',
          course: classroom.name,
          classroom_id: classroom.id,
          classroom_name: classroom.name,
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
        }),
      }),
      env,
    )

    expect(assignmentRes.status).toBe(201)

    const adaRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
        { method: 'GET' },
      ),
      env,
    )
    const graceRes = await worker.fetch(
      new Request(
        `https://edu.handtyped.app/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
        { method: 'GET' },
      ),
      env,
    )

    const adaConfig = await adaRes.json()
    const graceConfig = await graceRes.json()

    expect(adaConfig.assignments[0]).toMatchObject({
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
    expect(graceConfig.assignments[0]).toMatchObject({
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
})
