export const EDU_REALTIME_DO_NAME = 'tenant-realtime-hub'

function encoder() {
  return new TextEncoder()
}

function normalizeChannel(value) {
  return String(value || '').trim()
}

export function sseFrame(event, data) {
  const chunks = []
  if (event) {
    chunks.push(`event: ${event}`)
  }
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  for (const line of String(payload).split('\n')) {
    chunks.push(`data: ${line}`)
  }
  chunks.push('')
  return `${chunks.join('\n')}\n`
}

export function heartbeatFrame() {
  return ': heartbeat\n\n'
}

export function parseChannels(values = []) {
  const channels = new Set()
  for (const value of values) {
    for (const item of String(value || '').split(',')) {
      const normalized = normalizeChannel(item)
      if (normalized) {
        channels.add(normalized)
      }
    }
  }
  return [...channels]
}

export function buildTenantChannel(tenantId, suffix = 'dashboard') {
  return `tenant:${String(tenantId || '').trim()}:${suffix}`
}

export function buildAssignmentChannel(tenantId, assignmentId) {
  return buildTenantChannel(tenantId, `assignment:${String(assignmentId || '').trim()}`)
}

export function buildReplayChannel(tenantId, liveSessionId) {
  return buildTenantChannel(tenantId, `replay:${String(liveSessionId || '').trim()}`)
}

export function buildStudentAssignmentChannel({ tenantId, classroomId, assignmentId, studentKey }) {
  return `student:${String(tenantId || '').trim()}:${String(classroomId || '').trim()}:${String(
    assignmentId || '',
  ).trim()}:${String(studentKey || '').trim()}`
}

export function buildStudentAssignmentGroupChannel({ tenantId, classroomId, assignmentId }) {
  return `student-group:${String(tenantId || '').trim()}:${String(classroomId || '').trim()}:${String(
    assignmentId || '',
  ).trim()}`
}

export function buildStudentBootstrapChannel({ tenantId, classroomId }) {
  return `student-bootstrap:${String(tenantId || '').trim()}:${String(classroomId || '').trim()}`
}

async function publishToRealtimeHub(env, { channels = [], event = 'message', payload = {} } = {}) {
  const normalizedChannels = parseChannels(channels)
  if (!env?.EDU_REALTIME || !normalizedChannels.length) {
    return
  }
  const id = env.EDU_REALTIME.idFromName(EDU_REALTIME_DO_NAME)
  const stub = env.EDU_REALTIME.get(id)
  await stub.fetch('https://edu-realtime.internal/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      channels: normalizedChannels,
      event,
      payload,
    }),
  })
}

export async function publishRealtimeEvent(env, options) {
  try {
    await publishToRealtimeHub(env, options)
  } catch {
    // Realtime delivery is best-effort; writes should still succeed without it.
  }
}

export class EduRealtimeHub {
  constructor(state) {
    this.state = state
    this.clients = new Map()
    this.nextClientId = 1
    this.heartbeatTimer = null
  }

  ensureHeartbeat() {
    if (this.heartbeatTimer) {
      return
    }
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        try {
          client.writer.write(encoder().encode(heartbeatFrame()))
        } catch {
          this.dropClient(client.id)
        }
      }
      if (!this.clients.size) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
    }, 5000)
  }

  dropClient(clientId) {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }
    this.clients.delete(clientId)
    try {
      client.writer.close()
    } catch {
      // Ignore teardown issues.
    }
    if (!this.clients.size && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  async publish(message = {}) {
    const channels = new Set(parseChannels(message.channels || []))
    if (!channels.size) {
      return new Response(JSON.stringify({ delivered: 0 }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    const frame = encoder().encode(sseFrame(message.event || 'message', message.payload || {}))
    let delivered = 0
    for (const client of this.clients.values()) {
      if (!client.channels.some((channel) => channels.has(channel))) {
        continue
      }
      try {
        delivered += 1
        client.writer.write(frame).catch(() => {
          this.dropClient(client.id)
        })
      } catch {
        delivered -= 1
        this.dropClient(client.id)
      }
    }
    return new Response(JSON.stringify({ delivered }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  subscribe(url) {
    const channels = parseChannels(url.searchParams.getAll('channel'))
    if (!channels.length) {
      return new Response('Missing realtime channel', { status: 400 })
    }

    const stream = new TransformStream()
    const writer = stream.writable.getWriter()
    const clientId = this.nextClientId++
    const client = {
      id: clientId,
      channels,
      writer,
    }
    this.clients.set(clientId, client)
    this.ensureHeartbeat()

    writer.write(encoder().encode(sseFrame('ready', { channels }))).catch(() => {
      this.dropClient(clientId)
    })

    return new Response(stream.readable, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, must-revalidate',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/publish') {
      return this.publish(await request.json().catch(() => ({})))
    }
    if (request.method === 'GET' && url.pathname === '/subscribe') {
      return this.subscribe(url)
    }
    return new Response('Not found', { status: 404 })
  }
}
