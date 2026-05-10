import { describe, expect, it } from 'vitest'
import { EduRealtimeHub } from './edu-realtime.js'

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
