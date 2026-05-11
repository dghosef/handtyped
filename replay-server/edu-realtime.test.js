import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { EduRealtimeHub } from './edu-realtime.js'
import { createApp } from './server-lib.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createHubWithClients(clients) {
  const hub = new EduRealtimeHub({})
  hub.clients = new Map(clients.map((client) => [client.id, client]))
  return hub
}

describe('edu realtime hub', () => {
  it('does not block publishing behind a stalled SSE writer', async () => {
    const healthyWrites = []
    const hub = createHubWithClients([
      {
        id: 1,
        channels: ['tenant:test:assignment:essay'],
        writer: {
          write() {
            return new Promise(() => {})
          },
          close() {},
        },
      },
      {
        id: 2,
        channels: ['tenant:test:assignment:essay'],
        writer: {
          write(frame) {
            healthyWrites.push(new TextDecoder().decode(frame))
            return Promise.resolve()
          },
          close() {},
        },
      },
    ])

    const responseOrTimeout = await Promise.race([
      hub.publish({
        channels: ['tenant:test:assignment:essay'],
        event: 'assignment',
        payload: { live_sessions: [{ id: 'session-1' }] },
      }),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ])

    expect(responseOrTimeout).not.toBe('timed-out')
    expect(responseOrTimeout.status).toBe(200)
    expect(await responseOrTimeout.json()).toMatchObject({ delivered: 2 })
    expect(healthyWrites.join('')).toContain('event: assignment')
  })
})

describe('edu live replay updates', () => {
  let baseUrl
  let server
  let sessionsDir

  async function request(method, path, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: res.status,
      body: await res.json().catch(() => null),
      headers: res.headers,
    }
  }

  beforeAll(async () => {
    sessionsDir = join(__dirname, `edu-realtime-${randomUUID()}`)
    mkdirSync(sessionsDir, { recursive: true })
    const port = 10000 + Math.floor(Math.random() * 20000)
    baseUrl = `http://localhost:${port}`
    server = createApp(sessionsDir, { eduStoreDir: join(sessionsDir, 'edu-store') }).listen(port)
    await new Promise((resolve) => server.once('listening', resolve))
  })

  afterAll(() => {
    server?.close()
    if (sessionsDir && existsSync(sessionsDir)) {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('omits unchanged full draft text from incremental replay updates', async () => {
    const teacherEmail = `teacher-${randomUUID()}@edu.handtyped.app`
    const signup = await request('POST', '/api/edu/auth/signup', {
      name: 'Realtime Teacher',
      email: teacherEmail,
      password: 'realtime-password',
    })
    expect(signup.status).toBe(201)
    const cookie = signup.headers.get('set-cookie') || ''

    const sessionId = `live-${randomUUID()}`
    const largeText = `First line\n\n${'x'.repeat(60_000)}`
    const initial = await request('POST', '/api/edu/live-sessions', {
      id: sessionId,
      tenant_id: signup.body.tenant_id,
      assignment_id: 'assignment-1',
      assignment_title: 'Large Draft',
      classroom: 'Period 1',
      student_name: 'Ada Lovelace',
      current_text: largeText,
      document_history: [{ t: 1, pos: 0, ins: largeText }],
      last_activity_at: '2026-05-07T12:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(initial.status).toBe(201)

    const fullReplay = await request('GET', `/api/edu/live-replays/${encodeURIComponent(sessionId)}`, undefined, {
      Cookie: cookie,
    })
    expect(fullReplay.status).toBe(200)
    expect(fullReplay.body.current_text).toBe(largeText)

    const heartbeat = await request('POST', '/api/edu/live-sessions', {
      id: sessionId,
      tenant_id: signup.body.tenant_id,
      assignment_id: 'assignment-1',
      assignment_title: 'Large Draft',
      classroom: 'Period 1',
      student_name: 'Ada Lovelace',
      current_text: largeText,
      document_history: [{ t: 1, pos: 0, ins: largeText }],
      last_activity_at: '2026-05-07T12:00:05.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(heartbeat.status).toBe(201)

    const updates = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(sessionId)}/updates?since_seq=${encodeURIComponent(
        String(fullReplay.body.last_seq || 0),
      )}`,
      undefined,
      { Cookie: cookie },
    )
    expect(updates.status).toBe(200)
    expect(updates.body.current_text).toBeUndefined()
    expect(updates.body.current_text_length).toBe(largeText.length)
    expect(updates.body.events[0].current_text).toBeUndefined()
    expect(updates.body.events[0].current_text_length).toBe(largeText.length)
  })
})
