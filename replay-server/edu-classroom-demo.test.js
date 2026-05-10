import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_TEACHER_EMAIL = 'actual-teacher@edu.handtyped.app'
const TEST_TEACHER_PASSWORD = 'actual-teacher-password'

let baseUrl
let server
let sessionsDir
let eduStoreDir

const students = [
  'Ada Lovelace',
  'Grace Hopper',
  'Katherine Johnson',
  'Mary Jackson',
  'Dorothy Vaughan',
  'Annie Easley',
  'Margaret Hamilton',
  'Radia Perlman',
  'Evelyn Boyd Granville',
  'Barbara Liskov',
  'Karen Sparck Jones',
  'Frances Allen',
  'Jean Bartik',
  'Betty Holberton',
  'Joan Clarke',
  'Hedy Lamarr',
  'Gladys West',
  'Sister Mary Kenneth Keller',
  'Carol Shaw',
  'Adele Goldberg',
  'Marsha Rhea Williams',
  'Lynn Conway',
  'Sophie Wilson',
  'Erna Schneider Hoover',
  'Elizabeth Feinler',
  'Mary Allen Wilkes',
  'Alicia Boole Stott',
  'Christine Darden',
  'Lois Haibt',
  'Thelma Estrin',
  'Marlyn Meltzer',
  'Ruth Teitelbaum',
]

async function request(method, path, body, headers = {}) {
  const url = `${baseUrl}${path}`
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  }
  if (body !== undefined) {
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(url, opts)
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json, headers: res.headers }
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

function liveSessionIdFor(assignmentId, studentName) {
  return `demo:${assignmentId}:${studentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function draftFor(studentName, revision = 1) {
  const intro = `${studentName} argues that reliable evidence matters in a classroom.`
  if (revision === 1) return intro
  return `${intro}\n\nRevision ${revision} adds a concrete example from the shared reading.`
}

function historyFor(text, t = 100) {
  return [{ t, pos: 0, del: '', ins: text }]
}

async function publishStudent({ assignment, classroom, studentName, text, minute, scheduleOpen = true, focused = true }) {
  return request('POST', '/api/edu/live-sessions', {
    id: liveSessionIdFor(assignment.id, studentName),
    assignment_id: assignment.id,
    assignment_title: assignment.title,
    course: assignment.course,
    classroom: classroom.name,
    student_name: studentName,
    current_text: text,
    document_history: historyFor(text, minute * 100),
    current_url: minute % 2 === 0 ? 'https://example.edu/source' : null,
    current_url_title: minute % 2 === 0 ? 'Example Source' : null,
    url_history:
      minute % 2 === 0
        ? [
            {
              t: minute * 100 + 25,
              url: 'https://example.edu/source',
              allowed: true,
              source: 'embedded_navigation',
            },
          ]
        : [],
    violation_count: 0,
    violations: [],
    last_activity_at: `2026-04-28T14:${String(minute).padStart(2, '0')}:00.000Z`,
    schedule_open: scheduleOpen,
    focused,
    hid_active: true,
  })
}

beforeAll(async () => {
  sessionsDir = join(__dirname, `edu-classroom-demo-${randomUUID()}`)
  eduStoreDir = join(sessionsDir, 'edu-store')
  mkdirSync(sessionsDir, { recursive: true })
  const port = 10000 + Math.floor(Math.random() * 20000)
  baseUrl = `http://localhost:${port}`

  const { createApp } = await import('./server-lib.js')
  const app = createApp(sessionsDir, { eduStoreDir })
  await new Promise((resolve) => {
    server = app.listen(port, resolve)
  })
})

afterAll(() => {
  server?.close()
  if (sessionsDir && existsSync(sessionsDir)) {
    rmSync(sessionsDir, { recursive: true, force: true })
  }
})

describe('classroom demo contract', () => {
  it('keeps a whole class, teacher dashboard, reconnect, and feedback flow coherent', async () => {
    const joinCode = `DEM${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Demo English',
        teacher_name: 'Ms. Demo',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Whole-class live writing',
        course: 'Demo English',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Use evidence from the source and revise once.',
        policy: {
          allow_dictation: false,
          allow_offline_editing: true,
          copy_paste_allowed: false,
          export_allowed: false,
          images_allowed: false,
          require_lockdown: true,
          require_fullscreen: true,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://example.edu/source',
          allowed_domains: ['example.edu'],
          log_all_navigation: true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const configs = await Promise.all(
      students.map((studentName) =>
        request(
          'GET',
          `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent(studentName)}`,
        ),
      ),
    )
    expect(configs.map((config) => config.status)).toEqual(students.map(() => 200))
    expect(configs.every((config) => config.body.assignments.some((item) => item.id === assignment.body.id))).toBe(true)

    const opens = await Promise.all(
      students.map((studentName) =>
        request('POST', `/api/edu/student/assignments/${assignment.body.id}/open`, {
          join_code: joinCode,
          student_name: studentName,
        }),
      ),
    )
    expect(opens.map((open) => open.status)).toEqual(students.map(() => 201))

    const firstPublishes = await Promise.all(
      students.map((studentName, index) =>
        publishStudent({
          assignment: assignment.body,
          classroom: classroom.body,
          studentName,
          text: draftFor(studentName),
          minute: index % 20,
        }),
      ),
    )
    expect(firstPublishes.map((publish) => publish.status)).toEqual(students.map(() => 201))

    const reconnectingStudent = students[7]
    const disconnectedStudent = students[13]
    const revisedText = draftFor(reconnectingStudent, 2)
    const reconnect = await publishStudent({
      assignment: assignment.body,
      classroom: classroom.body,
      studentName: reconnectingStudent,
      text: revisedText,
      minute: 45,
    })
    expect(reconnect.status).toBe(201)
    expect(reconnect.body.current_text).toBe(revisedText)

    const closePresence = await publishStudent({
      assignment: assignment.body,
      classroom: classroom.body,
      studentName: disconnectedStudent,
      text: '',
      minute: 46,
      scheduleOpen: false,
      focused: false,
    })
    expect(closePresence.status).toBe(201)
    expect(closePresence.body.current_text).toBe(draftFor(disconnectedStudent))

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(dashboard.status).toBe(200)
    const demoSessions = dashboard.body.live_sessions.filter((session) => session.assignment_id === assignment.body.id)
    expect(demoSessions).toHaveLength(students.length)
    expect(demoSessions.find((session) => session.student_name === reconnectingStudent)).toMatchObject({
      current_text: revisedText,
      focused: true,
      hid_active: true,
    })
    expect(demoSessions.find((session) => session.student_name === disconnectedStudent)).toMatchObject({
      current_text: draftFor(disconnectedStudent),
      focused: false,
      schedule_open: false,
    })

    const replayUpdates = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(liveSessionIdFor(assignment.body.id, reconnectingStudent))}/updates?since_seq=1`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(replayUpdates.status).toBe(200)
    expect(replayUpdates.body.events).toHaveLength(1)
    expect(replayUpdates.body.events[0]).toMatchObject({
      seq: 2,
      current_text: revisedText,
    })

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionIdFor(assignment.body.id, reconnectingStudent))}/grading`,
      {
        teacher_comment: 'Keep the evidence, then make the claim more precise.',
        returned_for_revision: true,
        grade_label: 'Revise',
        inline_annotations: [
          {
            id: 'claim-note',
            type: 'comment',
            start: 0,
            end: reconnectingStudent.length,
            quote: reconnectingStudent,
            note: 'Start with the claim rather than the writer name.',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(grading.status).toBe(200)
    expect(grading.body.grading).toMatchObject({
      feedback_status: 'published',
      returned_for_revision: true,
      inline_annotations: [expect.objectContaining({ id: 'claim-note' })],
    })

    const feedbackConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent(reconnectingStudent)}`,
    )
    expect(feedbackConfig.status).toBe(200)
    expect(feedbackConfig.body.assignments.find((item) => item.id === assignment.body.id).student_feedback).toMatchObject({
      teacher_comment: 'Keep the evidence, then make the claim more precise.',
      returned_for_revision: true,
    })

    const resolution = await request('POST', `/api/edu/student/assignments/${assignment.body.id}/feedback-resolutions`, {
      join_code: joinCode,
      student_name: reconnectingStudent,
      annotation_key: 'id:claim-note',
    })
    expect(resolution.status).toBe(200)

    const resolvedSession = await request(
      'GET',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionIdFor(assignment.body.id, reconnectingStudent))}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(resolvedSession.status).toBe(200)
    expect(resolvedSession.body.grading.inline_annotations[0]).toMatchObject({
      id: 'claim-note',
      resolved_by_student: true,
      resolved_by: reconnectingStudent,
    })

    const targetedUpdate = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      { assigned_students: students.slice(0, students.length / 2) },
      { Cookie: login.cookie },
    )
    expect(targetedUpdate.status).toBe(200)

    const stillAssigned = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent(students[2])}`,
    )
    const noLongerAssigned = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent(students.at(-1))}`,
    )
    expect(stillAssigned.body.assignments.some((item) => item.id === assignment.body.id)).toBe(true)
    expect(noLongerAssigned.body.assignments.some((item) => item.id === assignment.body.id)).toBe(false)

    const delta = await request(
      'GET',
      `/api/edu/dashboard/updates?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(delta.status).toBe(200)
    expect(delta.body.live_sessions.filter((session) => session.assignment_id === assignment.body.id)).toHaveLength(students.length)
    expect(delta.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          assigned_students: students.slice(0, students.length / 2),
        }),
      ]),
    )
  })
})
