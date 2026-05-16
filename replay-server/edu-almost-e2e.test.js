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
  const signup = await teacherSignup({
    name: 'Actual Teacher',
    email: TEST_TEACHER_EMAIL,
    password: TEST_TEACHER_PASSWORD,
  })
  if (signup.status !== 201 && signup.status !== 400) {
    throw new Error(`Could not create test teacher account: ${signup.status}`)
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

async function teacherSignup({ name, email, password }) {
  const res = await fetch(`${baseUrl}/api/edu/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  })
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: res.headers.get('set-cookie') || '',
  }
}

beforeAll(async () => {
  sessionsDir = join(__dirname, `edu-almost-e2e-${randomUUID()}`)
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

describe('teacher almost end-to-end workflow', () => {
  it('creates, updates, monitors, and delivers a fake-typed assignment flow without UI clicks', async () => {
    const joinCode = `E2E${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Workflow English',
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
        title: '1984 draft',
        course: 'Workflow English',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Compare 1984 to today.',
        policy: {
          allow_dictation: false,
          allow_offline_editing: true,
          copy_paste_allowed: false,
          export_allowed: false,
          images_allowed: false,
          require_lockdown: true,
          require_fullscreen: true,
        },
      },
      { Cookie: login.cookie },
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
    expect(adaConfig.body.assignments).toHaveLength(1)
    expect(adaConfig.body.assignments[0]).toMatchObject({
      id: assignment.body.id,
      title: '1984 draft',
      prompt: 'Compare 1984 to today.',
    })
    expect(graceConfig.status).toBe(200)
    expect(graceConfig.body.assignments).toEqual([])

    const firstDraft = 'Compare 1984 to today'
    const secondDraft =
      'Compare 1984 to today\n\nBoth societies use surveillance to pressure people into compliance.'
    const liveSessionId = `live:${randomUUID()}`

    const firstPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: '1984 draft',
      course: 'Workflow English',
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: firstDraft,
      document_history: [
        { t: 120, pos: 0, del: '', ins: 'Compare 1984 to today' },
      ],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T14:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(firstPublish.status).toBe(201)

    const updatedAssignment = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        title: '1984 final draft',
        prompt: 'Compare 1984 to today with one specific modern parallel.',
      },
      { Cookie: login.cookie },
    )
    expect(updatedAssignment.status).toBe(200)

    const updatedConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(updatedConfig.status).toBe(200)
    expect(updatedConfig.body.assignments[0]).toMatchObject({
      id: assignment.body.id,
      title: '1984 final draft',
      prompt: 'Compare 1984 to today with one specific modern parallel.',
    })

    const secondPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: '1984 final draft',
      course: 'Workflow English',
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: secondDraft,
      document_history: [
        { t: 120, pos: 0, del: '', ins: 'Compare 1984 to today' },
        {
          t: 540,
          pos: 21,
          del: '',
          ins: '\n\nBoth societies use surveillance to pressure people into compliance.',
        },
      ],
      current_url: 'https://www.britannica.com/topic/Nineteen-Eighty-four',
      current_url_title: 'Nineteen Eighty-Four',
      url_history: [
        {
          t: 700,
          url: 'https://www.britannica.com/topic/Nineteen-Eighty-four',
          allowed: true,
          source: 'embedded_navigation',
        },
      ],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T14:01:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(secondPublish.status).toBe(201)
    expect(secondPublish.body).toMatchObject({
      id: liveSessionId,
      assignment_title: '1984 final draft',
      current_text: secondDraft,
    })

    const liveReplay = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(liveReplay.status).toBe(200)
    expect(liveReplay.body).toMatchObject({
      id: liveSessionId,
      live_session_id: liveSessionId,
      current_text: secondDraft,
      last_seq: 2,
    })
    expect(liveReplay.body.document_history).toEqual(secondPublish.body.document_history)
    expect(liveReplay.body.events.map((event) => event.seq)).toEqual([1, 2])
    expect(liveReplay.body.events[1].document_history_tail).toEqual([
      {
        t: 540,
        pos: 21,
        del: '',
        ins: '\n\nBoth societies use surveillance to pressure people into compliance.',
      },
    ])

    const liveReplayUpdates = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates?since_seq=1`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(liveReplayUpdates.status).toBe(200)
    expect(liveReplayUpdates.body).toMatchObject({
      id: liveSessionId,
      last_seq: 2,
      current_text: secondDraft,
    })
    expect(liveReplayUpdates.body.events).toHaveLength(1)
    expect(liveReplayUpdates.body.events[0]).toMatchObject({
      seq: 2,
      current_text: secondDraft,
    })

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          assignment_id: assignment.body.id,
          assignment_title: '1984 final draft',
          student_name: 'Ada Lovelace',
          current_text: secondDraft,
        }),
      ]),
    )

    const delta = await request(
      'GET',
      `/api/edu/dashboard/updates?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`,
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
    expect(delta.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          title: '1984 final draft',
        }),
      ]),
    )
  })

  it('retargets assignment visibility and preserves teacher feedback across later fake-typed updates', async () => {
    const joinCode = `RET${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Retarget Workshop',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const wholeClass = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Whole class warmup',
        course: 'Retarget Workshop',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Warm up in one paragraph.',
      },
      { Cookie: login.cookie },
    )
    expect(wholeClass.status).toBe(201)

    const targeted = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Ada only draft',
        course: 'Retarget Workshop',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Draft only for Ada.',
      },
      { Cookie: login.cookie },
    )
    expect(targeted.status).toBe(201)

    const beforeAda = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const beforeGrace = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(beforeAda.body.assignments.map((item) => item.title).sort()).toEqual([
      'Ada only draft',
      'Whole class warmup',
    ])
    expect(beforeGrace.body.assignments.map((item) => item.title).sort()).toEqual([
      'Whole class warmup',
    ])

    const liveSessionId = `live:${randomUUID()}`
    const firstText = 'Ada writes an initial targeted paragraph.'
    const revisedText = 'Ada writes an initial targeted paragraph.\n\nThen she revises it after teacher feedback.'

    const initialPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: targeted.body.id,
      assignment_title: targeted.body.title,
      course: targeted.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: firstText,
      document_history: [
        { t: 100, pos: 0, del: '', ins: firstText },
      ],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T15:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(initialPublish.status).toBe(201)

    const feedback = await request(
      'PUT',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`,
      {
        teacher_comment: 'Push the comparison further.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 82,
        inline_annotations: [
          {
            type: 'comment',
            start: 0,
            end: 3,
            quote: 'Ada',
            note: 'Name the student less directly in the final submission.',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(feedback.status).toBe(200)

    const laterPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: targeted.body.id,
      assignment_title: targeted.body.title,
      course: targeted.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: revisedText,
      document_history: [
        { t: 100, pos: 0, del: '', ins: firstText },
        { t: 340, pos: firstText.length, del: '', ins: '\n\nThen she revises it after teacher feedback.' },
      ],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T15:03:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(laterPublish.status).toBe(201)
    expect(laterPublish.body.grading).toMatchObject({
      teacher_comment: 'Push the comparison further.',
      grade_label: 'Revise',
      returned_for_revision: true,
    })

    const targetedRetarget = await request(
      'PUT',
      `/api/edu/assignments/${targeted.body.id}`,
      {
        assigned_students: ['Grace Hopper'],
        prompt: 'Now assigned to Grace.',
      },
      { Cookie: login.cookie },
    )
    expect(targetedRetarget.status).toBe(200)

    const afterAda = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const afterGrace = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )

    expect(afterAda.body.assignments.map((item) => item.title).sort()).toEqual([
      'Whole class warmup',
    ])
    expect(afterGrace.body.assignments.map((item) => item.title).sort()).toEqual([
      'Ada only draft',
      'Whole class warmup',
    ])

    const persisted = await request(
      'GET',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(persisted.status).toBe(200)
    expect(persisted.body).toMatchObject({
      current_text: revisedText,
      grading: {
        teacher_comment: 'Push the comparison further.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 82,
        inline_annotations: [
          expect.objectContaining({
            type: 'comment',
            quote: 'Ada',
          }),
        ],
      },
    })
  })

  it('keeps the teacher view current across multiple fake student revisions with advancing activity timestamps', async () => {
    const joinCode = `ACT${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Activity Monitor',
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
        title: 'Revision ladder',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Revise the same idea three times.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = `live:${randomUUID()}`
    const draftOne = 'The Party controls language.'
    const draftTwo = 'The Party controls language to shape what people can think.'
    const draftThree =
      'The Party controls language to shape what people can think, which turns censorship into a tool for obedience.'

    const firstPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: draftOne,
      document_history: [{ t: 60, pos: 0, del: '', ins: draftOne }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T16:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(firstPublish.status).toBe(201)

    const firstDashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(firstDashboard.status).toBe(200)
    expect(firstDashboard.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          current_text: draftOne,
          last_activity_at: '2026-04-28T16:00:00.000Z',
          document_history: [{ t: 60, pos: 0, del: '', ins: draftOne }],
        }),
      ]),
    )

    const secondPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: draftTwo,
      document_history: [
        { t: 60, pos: 0, del: '', ins: draftOne },
        { t: 180, pos: draftOne.length, del: '.', ins: ' to shape what people can think.' },
      ],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T16:02:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(secondPublish.status).toBe(201)

    const secondDelta = await request(
      'GET',
      `/api/edu/dashboard/updates?since=${encodeURIComponent(firstDashboard.body.updated_at)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(secondDelta.status).toBe(200)
    expect(secondDelta.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          current_text: draftTwo,
          last_activity_at: '2026-04-28T16:02:00.000Z',
          document_history: [
            { t: 60, pos: 0, del: '', ins: draftOne },
            { t: 180, pos: draftOne.length, del: '.', ins: ' to shape what people can think.' },
          ],
        }),
      ]),
    )

    const thirdPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: draftThree,
      document_history: [
        { t: 60, pos: 0, del: '', ins: draftOne },
        { t: 180, pos: draftOne.length, del: '.', ins: ' to shape what people can think.' },
        { t: 300, pos: draftTwo.length, del: '.', ins: ',' },
        {
          t: 360,
          pos: draftTwo.length + 1,
          del: '',
          ins: ' which turns censorship into a tool for obedience.',
        },
      ],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T16:05:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(thirdPublish.status).toBe(201)

    const finalDashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(finalDashboard.status).toBe(200)

    const finalLiveSession = finalDashboard.body.live_sessions.find((session) => session.id === liveSessionId)
    expect(finalLiveSession).toMatchObject({
      id: liveSessionId,
      current_text: draftThree,
      last_activity_at: '2026-04-28T16:05:00.000Z',
    })
    expect(finalLiveSession.document_history).toHaveLength(4)
    expect(finalLiveSession.document_history.map((entry) => entry.t)).toEqual([60, 180, 300, 360])
    expect(finalDashboard.body.live_sessions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          current_text: draftTwo,
        }),
      ]),
    )
  })

  it('removes a deleted assignment from student config while preserving teacher-facing saved live session state', async () => {
    const joinCode = `DEL${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Deletion Seminar',
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
        title: 'Delete after draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This assignment will be deleted after a saved draft.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const beforeDeleteConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(beforeDeleteConfig.status).toBe(200)
    expect(beforeDeleteConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          title: 'Delete after draft',
        }),
      ]),
    )

    const liveSessionId = `live:${randomUUID()}`
    const savedDraft = 'A saved local-facing draft exists before the teacher deletes the assignment.'
    const publish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: savedDraft,
      document_history: [{ t: 90, pos: 0, del: '', ins: savedDraft }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T17:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(publish.status).toBe(201)

    const deleted = await request(
      'DELETE',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body).toMatchObject({
      deleted: true,
      assignment_id: assignment.body.id,
    })

    const afterDeleteConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterDeleteConfig.status).toBe(200)
    expect(afterDeleteConfig.body.assignments).toEqual([])

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body.assignments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignment.body.id })]),
    )
    expect(dashboard.body.assignment_audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignment_id: assignment.body.id,
          action: 'deleted',
          assignment_title: 'Delete after draft',
        }),
      ]),
    )

    const persistedSession = await request(
      'GET',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(persistedSession.status).toBe(200)
    expect(persistedSession.body).toMatchObject({
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: 'Delete after draft',
      current_text: savedDraft,
      student_name: 'Ada Lovelace',
    })
  })

  it('refreshes targeted assignment visibility immediately after repeated retargeting updates', async () => {
    const joinCode = `RTG${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Visibility Workshop',
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const targeted = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Retargeted draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Ada sees this first.',
      },
      { Cookie: login.cookie },
    )
    expect(targeted.status).toBe(201)

    const beforeAda = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const beforeGrace = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(beforeAda.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: targeted.body.id,
          title: 'Retargeted draft',
          prompt: 'Ada sees this first.',
        }),
      ]),
    )
    expect(beforeGrace.body.assignments).toEqual([])

    const toGrace = await request(
      'PUT',
      `/api/edu/assignments/${targeted.body.id}`,
      {
        assigned_students: ['Grace Hopper'],
        prompt: 'Grace sees this next.',
      },
      { Cookie: login.cookie },
    )
    expect(toGrace.status).toBe(200)

    const afterGraceAda = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const afterGraceGrace = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(afterGraceAda.body.assignments).toEqual([])
    expect(afterGraceGrace.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: targeted.body.id,
          title: 'Retargeted draft',
          prompt: 'Grace sees this next.',
        }),
      ]),
    )

    const toBoth = await request(
      'PUT',
      `/api/edu/assignments/${targeted.body.id}`,
      {
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        prompt: 'Now both students see it.',
      },
      { Cookie: login.cookie },
    )
    expect(toBoth.status).toBe(200)

    const afterBothAda = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const afterBothGrace = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(afterBothAda.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: targeted.body.id,
          title: 'Retargeted draft',
          prompt: 'Now both students see it.',
        }),
      ]),
    )
    expect(afterBothGrace.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: targeted.body.id,
          title: 'Retargeted draft',
          prompt: 'Now both students see it.',
        }),
      ]),
    )
  })

  it('persists suggestion feedback through teacher grading, student config refresh, and later live publishes', async () => {
    const joinCode = `SGG${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Suggestion Workshop',
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
        title: 'Revision with suggestions',
        course: 'Suggestion Workshop',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Draft a claim and be ready for teacher suggestions.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = `live:${randomUUID()}`
    const firstDraft = 'This claim needs more detail.'
    const revisedDraft = 'This argument needs a more specific claim and stronger detail.'

    const firstPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: firstDraft,
      document_history: [
        { t: 100, pos: 0, del: '', ins: firstDraft },
      ],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T16:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(firstPublish.status).toBe(201)

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`,
      {
        teacher_comment: 'Good start. Make the claim more precise.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 83,
        inline_annotations: [
          {
            type: 'comment',
            start: 0,
            end: 10,
            quote: 'This claim',
            note: 'Name the actual argument.',
          },
          {
            type: 'suggestion',
            start: 5,
            end: 10,
            quote: 'claim',
            replacement: 'argument',
            note: 'This is more specific.',
          },
          {
            type: 'suggestion',
            start: 22,
            end: 33,
            quote: 'more detail',
            replacement: 'stronger detail',
            note: 'Tie the evidence back to the thesis.',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(grading.status).toBe(200)
    expect(grading.body.grading.inline_annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'suggestion', replacement: 'argument' }),
        expect.objectContaining({ type: 'suggestion', replacement: 'stronger detail' }),
      ]),
    )

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
            teacher_comment: 'Good start. Make the claim more precise.',
            returned_for_revision: true,
            inline_annotations: expect.arrayContaining([
              expect.objectContaining({ type: 'comment', quote: 'This claim' }),
              expect.objectContaining({ type: 'suggestion', replacement: 'argument' }),
              expect.objectContaining({ type: 'suggestion', replacement: 'stronger detail' }),
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
    expect(graceConfig.body.assignments).toEqual([])

    const laterPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: revisedDraft,
      document_history: [
        { t: 100, pos: 0, del: '', ins: firstDraft },
        { t: 460, pos: 5, del: 'claim', ins: 'argument' },
        { t: 720, pos: 22, del: 'more detail', ins: 'stronger detail' },
      ],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T16:04:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(laterPublish.status).toBe(201)
    expect(laterPublish.body.grading).toMatchObject({
      teacher_comment: 'Good start. Make the claim more precise.',
      returned_for_revision: true,
      inline_annotations: [
        expect.objectContaining({ type: 'comment', quote: 'This claim' }),
        expect.objectContaining({ type: 'suggestion', replacement: 'argument' }),
        expect.objectContaining({ type: 'suggestion', replacement: 'stronger detail' }),
      ],
    })

    const persisted = await request(
      'GET',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(persisted.status).toBe(200)
    expect(persisted.body).toMatchObject({
      current_text: revisedDraft,
      grading: {
        teacher_comment: 'Good start. Make the claim more precise.',
        returned_for_revision: true,
        inline_annotations: [
          expect.objectContaining({ type: 'comment', quote: 'This claim' }),
          expect.objectContaining({ type: 'suggestion', replacement: 'argument' }),
          expect.objectContaining({ type: 'suggestion', replacement: 'stronger detail' }),
        ],
      },
    })
  })

  it('lets the teacher see each student edit immediately after opening the live review', async () => {
    const joinCode = `LIV${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Immediate Live Review',
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
        title: 'Live review draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Revise live while the teacher watches.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = `live:${randomUUID()}`
    const drafts = [
      'The thesis starts here.',
      'The thesis starts here.\n\nNow the student adds evidence.',
      'The thesis starts here.\n\nNow the student adds evidence.\n\nFinally the conclusion lands.',
    ]
    const histories = [
      [{ t: 100, pos: 0, del: '', ins: drafts[0] }],
      [
        { t: 100, pos: 0, del: '', ins: drafts[0] },
        { t: 260, pos: drafts[0].length, del: '', ins: '\n\nNow the student adds evidence.' },
      ],
      [
        { t: 100, pos: 0, del: '', ins: drafts[0] },
        { t: 260, pos: drafts[0].length, del: '', ins: '\n\nNow the student adds evidence.' },
        { t: 420, pos: drafts[1].length, del: '', ins: '\n\nFinally the conclusion lands.' },
      ],
    ]
    const urls = [
      [],
      [
        {
          t: 300,
          url: 'https://example.com/evidence',
          allowed: true,
          source: 'embedded_navigation',
        },
      ],
      [
        {
          t: 300,
          url: 'https://example.com/evidence',
          allowed: true,
          source: 'embedded_navigation',
        },
        {
          t: 460,
          url: 'https://example.com/conclusion',
          allowed: true,
          source: 'embedded_navigation',
        },
      ],
    ]
    const activityTimes = [
      '2026-04-28T17:00:00.000Z',
      '2026-04-28T17:00:01.000Z',
      '2026-04-28T17:00:02.000Z',
    ]

    const firstPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: drafts[0],
      document_history: histories[0],
      current_url: null,
      current_url_title: null,
      url_history: urls[0],
      violation_count: 0,
      violations: [],
      last_activity_at: activityTimes[0],
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(firstPublish.status).toBe(201)

    const teacherOpenReview = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherOpenReview.status).toBe(200)
    expect(teacherOpenReview.body).toMatchObject({
      id: liveSessionId,
      current_text: drafts[0],
      last_seq: 1,
      last_activity_at: activityTimes[0],
    })
    expect(teacherOpenReview.body.document_history).toEqual(histories[0])
    expect(teacherOpenReview.body.events.map((event) => event.seq)).toEqual([1])

    const secondPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: drafts[1],
      document_history: histories[1],
      current_url: 'https://example.com/evidence',
      current_url_title: 'Evidence',
      url_history: urls[1],
      violation_count: 0,
      violations: [],
      last_activity_at: activityTimes[1],
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(secondPublish.status).toBe(201)

    const firstImmediateUpdate = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates?since_seq=1`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(firstImmediateUpdate.status).toBe(200)
    expect(firstImmediateUpdate.body).toMatchObject({
      id: liveSessionId,
      current_text: drafts[1],
      last_seq: 2,
      last_activity_at: activityTimes[1],
      current_url: 'https://example.com/evidence',
      current_url_title: 'Evidence',
    })
    expect(firstImmediateUpdate.body.events).toHaveLength(1)
    expect(firstImmediateUpdate.body.events[0]).toMatchObject({
      seq: 2,
      current_text: drafts[1],
      document_history_tail: [histories[1][1]],
      url_history_tail: urls[1],
    })

    const thirdPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: drafts[2],
      document_history: histories[2],
      current_url: 'https://example.com/conclusion',
      current_url_title: 'Conclusion',
      url_history: urls[2],
      violation_count: 0,
      violations: [],
      last_activity_at: activityTimes[2],
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(thirdPublish.status).toBe(201)

    const secondImmediateUpdate = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates?since_seq=2`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(secondImmediateUpdate.status).toBe(200)
    expect(secondImmediateUpdate.body).toMatchObject({
      id: liveSessionId,
      current_text: drafts[2],
      last_seq: 3,
      last_activity_at: activityTimes[2],
      current_url: 'https://example.com/conclusion',
      current_url_title: 'Conclusion',
    })
    expect(secondImmediateUpdate.body.events).toHaveLength(1)
    expect(secondImmediateUpdate.body.events[0]).toMatchObject({
      seq: 3,
      current_text: drafts[2],
      document_history_tail: [histories[2][2]],
      url_history_tail: [urls[2][1]],
    })

    const teacherSessionView = await request(
      'GET',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherSessionView.status).toBe(200)
    expect(teacherSessionView.body).toMatchObject({
      id: liveSessionId,
      current_text: drafts[2],
      last_activity_at: activityTimes[2],
      current_url: 'https://example.com/conclusion',
      current_url_title: 'Conclusion',
    })

    const teacherDashboardDelta = await request(
      'GET',
      `/api/edu/dashboard/updates?since=${encodeURIComponent(activityTimes[0])}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherDashboardDelta.status).toBe(200)
    expect(teacherDashboardDelta.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          current_text: drafts[2],
          last_activity_at: activityTimes[2],
          current_url: 'https://example.com/conclusion',
          current_url_title: 'Conclusion',
        }),
      ]),
    )
  })

  it('keeps teacher access controls, starter content, references, and student-visible state aligned through a full reopen cycle', async () => {
    const joinCode = `CTL${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Control Plane Seminar',
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
        title: 'Notebook source notes',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
      },
      { Cookie: login.cookie },
    )
    expect(priorAssignment.status).toBe(201)

    const priorLiveSessionId = `prior-live:${randomUUID()}`
    const priorDraft = 'Prior notes about surveillance, propaganda, and fear.'
    const priorPublish = await request('POST', '/api/edu/live-sessions', {
      id: priorLiveSessionId,
      assignment_id: priorAssignment.body.id,
      assignment_title: priorAssignment.body.title,
      course: priorAssignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: priorDraft,
      document_history: [{ t: 120, pos: 0, del: '', ins: priorDraft }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T18:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(priorPublish.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Control workflow draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Use your notes and revise with teacher controls.',
        starter_document: '# Default outline\n\n- Claim\n- Evidence',
        linked_assignment_ids: [priorAssignment.body.id],
        temporary_access_until: '2099-01-01T22:00:00.000Z',
        policy: {
          allow_dictation: true,
          allow_offline_editing: true,
          copy_paste_allowed: false,
          export_allowed: true,
          images_allowed: false,
          require_lockdown: true,
          require_permission_to_rejoin: true,
          require_fullscreen: true,
          show_rubric_to_student: true,
        },
        editor_policy: {
          font_family: 'mono',
          font_size: 18,
          line_height: 'double',
          font_locked: true,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://library.example.org/packet',
          mode: 'blacklist',
          allowed_domains: ['library.example.org', 'gutenberg.org'],
          log_all_navigation: true,
        },
        reference_documents: [
          {
            title: 'Speech Packet',
            mime_type: 'application/pdf',
            data_url: 'data:application/pdf;base64,JVBERi0xLjQK',
            size_bytes: 1234,
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const initialState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(initialState.status).toBe(200)
    expect(initialState.body).toMatchObject({
      assignment: {
        id: assignment.body.id,
        starter_document: '# Default outline\n\n- Claim\n- Evidence',
        linked_assignment_ids: [priorAssignment.body.id],
        temporary_access_until: '2099-01-01T22:00:00.000Z',
        access_revoked: false,
        policy: {
          allow_dictation: true,
          require_permission_to_rejoin: true,
          show_rubric_to_student: true,
        },
        editor_policy: {
          font_family: 'mono',
          font_size: 18,
          line_height: 'double',
          font_locked: true,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://library.example.org/packet',
          mode: 'blacklist',
          allowed_domains: ['library.example.org', 'gutenberg.org'],
        },
        reference_documents: [
          expect.objectContaining({
            title: 'Speech Packet',
            mime_type: 'application/pdf',
          }),
        ],
      },
    })

    const hiddenState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(hiddenState.status).toBe(404)
    expect(hiddenState.body).toMatchObject({ error: 'Not found' })

    const liveSessionId = `control-live:${randomUUID()}`
    const firstDraft = 'Ada starts from the default outline and drafts a claim.'
    const firstPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: firstDraft,
      document_history: [{ t: 180, pos: 0, del: '', ins: firstDraft }],
      current_url: 'https://library.example.org/packet',
      current_url_title: 'Packet',
      url_history: [
        {
          t: 210,
          url: 'https://library.example.org/packet',
          allowed: true,
          source: 'embedded_navigation',
        },
      ],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T18:08:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(firstPublish.status).toBe(201)

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`,
      {
        teacher_comment: 'Sharper. Now connect the evidence directly.',
        returned_for_revision: true,
        rubric_scores: { thesis: 3, evidence: 2 },
        inline_annotations: [
          {
            type: 'comment',
            start: 0,
            end: 3,
            quote: 'Ada',
            note: 'Remove the self-reference in the final version.',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(grading.status).toBe(200)

    const feedbackVisible = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(feedbackVisible.status).toBe(200)
    expect(feedbackVisible.body.assignment.student_feedback).toMatchObject({
      teacher_comment: 'Sharper. Now connect the evidence directly.',
      returned_for_revision: true,
      rubric_scores: { thesis: 3, evidence: 2 },
      inline_annotations: [expect.objectContaining({ quote: 'Ada' })],
    })

    const closedUpdate = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        starter_document: '# Revised outline\n\n- Thesis\n- Evidence\n- Conclusion',
        policy: {
          allow_dictation: false,
          show_rubric_to_student: false,
          require_permission_to_rejoin: true,
        },
        editor_policy: {
          font_family: 'sans',
          font_size: 24,
          line_height: 'single',
          font_locked: false,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://approved.example.org/home',
          mode: 'whitelist',
          allowed_domains: ['approved.example.org'],
          log_all_navigation: true,
        },
        reference_documents: [
          {
            title: 'Approved Packet',
            mime_type: 'application/pdf',
            data_url: 'data:application/pdf;base64,JVBERi0xLjQKMi4uLg==',
            size_bytes: 2345,
          },
        ],
        student_access_revoked: {
          'ada lovelace': true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(closedUpdate.status).toBe(200)

    const closedState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(closedState.status).toBe(200)
    expect(closedState.body).toMatchObject({
      assignment: {
        access_revoked: true,
        starter_document: '# Revised outline\n\n- Thesis\n- Evidence\n- Conclusion',
        policy: {
          allow_dictation: false,
          require_permission_to_rejoin: true,
          show_rubric_to_student: false,
        },
        editor_policy: {
          font_family: 'sans',
          font_size: 24,
          line_height: 'single',
          font_locked: false,
        },
        browser_policy: {
          mode: 'whitelist',
          home_url: 'https://approved.example.org/home',
          allowed_domains: ['approved.example.org'],
        },
        reference_documents: [
          expect.objectContaining({
            title: 'Approved Packet',
            size_bytes: 2345,
          }),
        ],
        student_feedback: expect.objectContaining({
          teacher_comment: 'Sharper. Now connect the evidence directly.',
          returned_for_revision: true,
        }),
      },
    })

    const accessRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'I need ten more minutes to finish the conclusion.',
      },
    )
    expect(accessRequest.status).toBe(201)

    const configWithRequest = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(configWithRequest.status).toBe(200)
    expect(configWithRequest.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          access_revoked: true,
          student_access_request: expect.objectContaining({
            student_name: 'Ada Lovelace',
            note: 'I need ten more minutes to finish the conclusion.',
          }),
        }),
      ]),
    )

    const reopenedUntil = '2099-01-02T01:15:00.000Z'
    const reopen = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_access_requests: {},
        student_access_revoked: {},
        student_temporary_access_until: {
          'ada lovelace': reopenedUntil,
        },
      },
      { Cookie: login.cookie },
    )
    expect(reopen.status).toBe(200)

    const reopenedState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(reopenedState.status).toBe(200)
    expect(reopenedState.body).toMatchObject({
      assignment: {
        access_revoked: false,
        temporary_access_until: reopenedUntil,
        student_access_request: null,
        student_feedback: expect.objectContaining({
          teacher_comment: 'Sharper. Now connect the evidence directly.',
          rubric_scores: { thesis: 3, evidence: 2 },
        }),
      },
    })
  })

  it('applies student-specific override controls without leaking them to classmates and keeps later teacher edits coherent', async () => {
    const joinCode = `OVR${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Override Lab',
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
        title: 'Override draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Everybody drafts, but Ada gets custom settings.',
        temporary_access_until: '2099-01-03T00:00:00.000Z',
        policy: {
          allow_dictation: false,
          show_rubric_to_student: false,
          require_permission_to_rejoin: false,
        },
        editor_policy: {
          font_family: 'times',
          font_size: 12,
          line_height: 'double',
          font_locked: false,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://class.example.org/home',
          mode: 'whitelist',
          allowed_domains: ['class.example.org'],
          log_all_navigation: true,
        },
        student_overrides: {
          'ada lovelace': {
            student_name: 'Ada Lovelace',
            temporary_access_until: '2099-01-03T02:30:00.000Z',
            policy: {
              allow_dictation: true,
              show_rubric_to_student: true,
              require_permission_to_rejoin: true,
            },
            editor_policy: {
              font_family: 'mono',
              font_size: 28,
              line_height: 'double',
              font_locked: true,
            },
            browser_policy: {
              browser_enabled: false,
              home_url: 'https://ada.example.org/private',
              mode: 'blacklist',
              allowed_domains: ['ada.example.org'],
            },
          },
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const adaState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaState.status).toBe(200)
    expect(graceState.status).toBe(200)
    expect(adaState.body).toMatchObject({
      assignment: {
        temporary_access_until: '2099-01-03T02:30:00.000Z',
        policy: {
          allow_dictation: true,
          show_rubric_to_student: true,
          require_permission_to_rejoin: true,
        },
        editor_policy: {
          font_family: 'mono',
          font_size: 28,
          line_height: 'double',
          font_locked: true,
        },
        browser_policy: {
          browser_enabled: false,
          home_url: 'https://ada.example.org/private',
          mode: 'blacklist',
          allowed_domains: ['ada.example.org'],
        },
      },
    })
    expect(graceState.body).toMatchObject({
      assignment: {
        temporary_access_until: '2099-01-03T00:00:00.000Z',
        policy: {
          allow_dictation: false,
          show_rubric_to_student: false,
          require_permission_to_rejoin: false,
        },
        editor_policy: {
          font_family: 'times',
          font_size: 12,
          line_height: 'double',
          font_locked: false,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://class.example.org/home',
          mode: 'whitelist',
          allowed_domains: ['class.example.org'],
        },
      },
    })

    const update = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        policy: {
          allow_dictation: false,
          show_rubric_to_student: false,
          require_permission_to_rejoin: false,
        },
        editor_policy: {
          font_family: 'sans',
          font_size: 16,
          line_height: 'single',
          font_locked: false,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://class.example.org/updated',
          mode: 'whitelist',
          allowed_domains: ['class.example.org', 'sources.example.org'],
          log_all_navigation: true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(update.status).toBe(200)

    const adaAfterUpdate = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceAfterUpdate = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaAfterUpdate.status).toBe(200)
    expect(graceAfterUpdate.status).toBe(200)
    expect(adaAfterUpdate.body.assignment).toMatchObject({
      policy: {
        allow_dictation: true,
        show_rubric_to_student: true,
        require_permission_to_rejoin: true,
      },
      editor_policy: {
        font_family: 'mono',
        font_size: 28,
        line_height: 'double',
        font_locked: true,
      },
      browser_policy: {
        browser_enabled: false,
        home_url: 'https://ada.example.org/private',
        mode: 'blacklist',
        allowed_domains: ['ada.example.org'],
      },
    })
    expect(graceAfterUpdate.body.assignment).toMatchObject({
      policy: {
        allow_dictation: false,
        show_rubric_to_student: false,
        require_permission_to_rejoin: false,
      },
      editor_policy: {
        font_family: 'sans',
        font_size: 16,
        line_height: 'single',
        font_locked: false,
      },
      browser_policy: {
        browser_enabled: true,
        home_url: 'https://class.example.org/updated',
        mode: 'whitelist',
        allowed_domains: ['class.example.org', 'sources.example.org'],
      },
    })
  })

  it('keeps signup, logout, destructive teacher actions, and student visibility cleanup aligned', async () => {
    const joinCode = `DEL${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`
    const classroomName = `Deletion Seminar ${randomUUID().replace(/-/g, '').slice(0, 6)}`
    const email = `teacher+${randomUUID()}@edu.handtyped.app`
    const password = 'handtyped-edu'

    const signup = await teacherSignup({
      name: 'Deletion Teacher',
      email,
      password,
    })
    expect(signup.status).toBe(201)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: classroomName,
        teacher_name: 'Deletion Teacher',
        join_code: joinCode,
      },
      { Cookie: signup.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Delete me after review',
        course: classroomName,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Write a short response before deletion.',
      },
      { Cookie: signup.cookie },
    )
    expect(assignment.status).toBe(201)

    const beforeDelete = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(beforeDelete.status).toBe(200)
    expect(beforeDelete.body.classroom).toMatchObject({ id: classroom.body.id })
    expect(beforeDelete.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignment.body.id })]),
    )

    const logout = await request('POST', '/api/edu/auth/logout', undefined, {
      Cookie: signup.cookie,
    })
    expect(logout.status).toBe(200)

    const unauthorizedDelete = await request(
      'DELETE',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: signup.cookie },
    )
    expect(unauthorizedDelete.status).toBe(401)

    const login = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'password',
        email,
        password,
      }),
    })
    const reloginCookie = login.headers.get('set-cookie') || ''
    expect(login.status).toBe(200)

    const deleteAssignment = await request(
      'DELETE',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: reloginCookie },
    )
    expect(deleteAssignment.status).toBe(200)

    const afterAssignmentDelete = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterAssignmentDelete.status).toBe(200)
    expect(afterAssignmentDelete.body.classroom).toMatchObject({ id: classroom.body.id })
    expect(afterAssignmentDelete.body.assignments).toEqual([])

    const assignmentDetailAfterDelete = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(assignmentDetailAfterDelete.status).toBe(404)

    const deleteClassroom = await request(
      'DELETE',
      `/api/edu/classrooms/${classroom.body.id}`,
      undefined,
      { Cookie: reloginCookie },
    )
    expect(deleteClassroom.status).toBe(200)

    const afterClassroomDelete = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterClassroomDelete.status).toBe(200)
    expect(afterClassroomDelete.body).toEqual({
      classroom: null,
      canonical_student_name: null,
      assignments: [],
    })
  })

  it('keeps classroom renames, join-code changes, assignment retitles, and teacher dashboard reads aligned', async () => {
    const originalJoinCode = `REN${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const nextJoinCode = `UPD${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Rename Workshop',
        teacher_name: 'Ms. Keating',
        join_code: originalJoinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: 'Original Draft Title',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Write the original version first.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const beforeRename = await request(
      'GET',
      `/api/edu/student/config?join_code=${originalJoinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(beforeRename.status).toBe(200)
    expect(beforeRename.body.classroom).toMatchObject({
      id: classroom.body.id,
      name: 'Rename Workshop',
      join_code: originalJoinCode,
    })
    expect(beforeRename.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          title: 'Original Draft Title',
        }),
      ]),
    )

    const renamedClassroom = await request(
      'PUT',
      `/api/edu/classrooms/${classroom.body.id}`,
      {
        name: 'Renamed Seminar',
        join_code: nextJoinCode,
        teacher_name: 'Ms. Keating',
      },
      { Cookie: login.cookie },
    )
    expect(renamedClassroom.status).toBe(200)

    const retitledAssignment = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        title: 'Retitled Draft',
        classroom_name: 'Renamed Seminar',
        course: 'Renamed Seminar',
        prompt: 'Write the revised version now.',
      },
      { Cookie: login.cookie },
    )
    expect(retitledAssignment.status).toBe(200)

    const oldCodeConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${originalJoinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(oldCodeConfig.status).toBe(200)
    expect(oldCodeConfig.body).toEqual({
      classroom: null,
      canonical_student_name: null,
      assignments: [],
    })

    const newCodeConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${nextJoinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(newCodeConfig.status).toBe(200)
    expect(newCodeConfig.body.classroom).toMatchObject({
      id: classroom.body.id,
      name: 'Renamed Seminar',
      join_code: nextJoinCode,
    })
    expect(newCodeConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          title: 'Retitled Draft',
          prompt: 'Write the revised version now.',
          classroom_name: 'Renamed Seminar',
          course: 'Renamed Seminar',
        }),
      ]),
    )

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
      Cookie: login.cookie,
    })
    expect(dashboard.status).toBe(200)
    expect(dashboard.body.classrooms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: classroom.body.id,
          name: 'Renamed Seminar',
          join_code: nextJoinCode,
        }),
      ]),
    )
    expect(dashboard.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          title: 'Retitled Draft',
          classroom_name: 'Renamed Seminar',
        }),
      ]),
    )
  })

  it('carries a student access request through teacher approval, live writing, and dashboard/live-summary refreshes', async () => {
    const joinCode = `REQ${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Request Approval Lab',
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
        title: 'Closed Draft',
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        windows: [
          {
            label: 'Morning block',
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

    const requestAccess = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'Need to finish after school.',
      },
    )
    expect(requestAccess.status).toBe(201)

    const pendingConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(pendingConfig.status).toBe(200)
    expect(pendingConfig.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assignment.body.id,
          student_access_request: expect.objectContaining({
            student_name: 'Ada Lovelace',
            note: 'Need to finish after school.',
          }),
        }),
      ]),
    )

    const approvedUntil = '2099-01-05T23:00:00.000Z'
    const approve = await request(
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
    expect(approve.status).toBe(200)

    const liveSessionId = `approved-live:${randomUUID()}`
    const publish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'Approved after-school writing.',
      document_history: [{ t: 150, pos: 0, del: '', ins: 'Approved after-school writing.' }],
      current_url: 'https://example.org/after-school-source',
      current_url_title: 'After school source',
      url_history: [
        {
          t: 180,
          url: 'https://example.org/after-school-source',
          allowed: true,
          source: 'embedded_navigation',
        },
      ],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T20:30:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(publish.status).toBe(201)

    const studentState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentState.status).toBe(200)
    expect(studentState.body.assignment).toMatchObject({
      id: assignment.body.id,
      temporary_access_until: approvedUntil,
      student_access_request: null,
    })

    const liveSummaries = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/live-summaries`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(liveSummaries.status).toBe(200)
    expect(liveSummaries.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          student_name: 'Ada Lovelace',
          current_text: 'Approved after-school writing.',
        }),
      ]),
    )

    const dashboardDelta = await request(
      'GET',
      `/api/edu/dashboard/updates?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(dashboardDelta.status).toBe(200)
    expect(dashboardDelta.body.live_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: liveSessionId,
          assignment_id: assignment.body.id,
          student_name: 'Ada Lovelace',
          current_text: 'Approved after-school writing.',
        }),
      ]),
    )
  })

  it('keeps saved replay reads linked to the teacher live review after later student edits', async () => {
    const joinCode = `RPL${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Replay Seminar ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Replay Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Write, save, and replay the same draft.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = `replay-live:${randomUUID()}`
    const replayId = `replay:${randomUUID()}`
    const firstDraft = 'Opening replay draft.'
    const secondDraft = 'Opening replay draft.\n\nA later paragraph arrives.'

    const firstPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: firstDraft,
      document_history: [{ t: 100, pos: 0, del: '', ins: firstDraft }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T19:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
      replay_session_id: replayId,
    })
    expect(firstPublish.status).toBe(201)

    const replayPublish = await request('POST', '/api/edu/replays', {
      id: replayId,
      live_session_id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: firstDraft,
      document_history: [{ t: 100, text: firstDraft }],
      replay_origin_wall_ms: 1714330800000,
      recorded_timezone_offset_minutes: -240,
      recorded_timezone: 'America/New_York',
    })
    expect(replayPublish.status).toBe(201)

    const replayRead = await request(
      'GET',
      `/api/edu/replays/${encodeURIComponent(replayId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(replayRead.status).toBe(200)
    expect(replayRead.body).toMatchObject({
      id: replayId,
      live_session_id: liveSessionId,
      assignment_id: assignment.body.id,
      current_text: firstDraft,
      assignment: {
        id: assignment.body.id,
        title: assignment.body.title,
      },
    })

    const liveReplayBeforeUpdate = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(liveReplayBeforeUpdate.status).toBe(200)
    expect(liveReplayBeforeUpdate.body).toMatchObject({
      id: liveSessionId,
      replay_session_id: replayId,
      current_text: firstDraft,
    })

    const secondPublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: secondDraft,
      document_history: [
        { t: 100, pos: 0, del: '', ins: firstDraft },
        { t: 420, pos: firstDraft.length, del: '', ins: '\n\nA later paragraph arrives.' },
      ],
      current_url: 'https://example.org/replay-source',
      current_url_title: 'Replay Source',
      url_history: [{ t: 450, url: 'https://example.org/replay-source', allowed: true, source: 'embedded_navigation' }],
      violation_count: 0,
      violations: [],
      last_activity_at: '2026-04-28T19:04:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
      replay_session_id: replayId,
    })
    expect(secondPublish.status).toBe(201)

    const liveReplayAfterUpdate = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates?since_seq=1`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(liveReplayAfterUpdate.status).toBe(200)
    expect(liveReplayAfterUpdate.body).toMatchObject({
      id: liveSessionId,
      replay_session_id: replayId,
      current_text: secondDraft,
      last_seq: 2,
      current_url: 'https://example.org/replay-source',
      current_url_title: 'Replay Source',
    })
    expect(liveReplayAfterUpdate.body.events).toEqual([
      expect.objectContaining({
        seq: 2,
        current_text: secondDraft,
      }),
    ])

    const replayReadAfterUpdate = await request(
      'GET',
      `/api/edu/replays/${encodeURIComponent(replayId)}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(replayReadAfterUpdate.status).toBe(200)
    expect(replayReadAfterUpdate.body).toMatchObject({
      id: replayId,
      current_text: firstDraft,
      assignment: {
        id: assignment.body.id,
      },
    })
  })

  it('records assignment audits in order across teacher edits and student access requests', async () => {
    const joinCode = `AUD${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Audit Seminar ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Audit Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        prompt: 'Track every meaningful change.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const requested = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'Need more time for the last paragraph.',
      },
    )
    expect(requested.status).toBe(201)

    const updated = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        prompt: 'Track every meaningful change, including teacher edits.',
        starter_document: '# Start here\n\nDraft your claim.',
        policy: {
          allow_dictation: true,
          show_rubric_to_student: true,
          export_allowed: true,
        },
        editor_policy: {
          font_family: 'serif',
          font_size: 20,
          line_height: 'one-half',
          font_locked: true,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://approved.example.org/reader',
          mode: 'whitelist',
          allowed_domains: ['approved.example.org'],
          log_all_navigation: true,
        },
        reference_documents: [
          {
            title: 'Audit Packet',
            mime_type: 'application/pdf',
            data_url: 'data:application/pdf;base64,JVBERi0xLjQK',
            size_bytes: 1400,
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(updated.status).toBe(200)

    const audit = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/audit`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(audit.status).toBe(200)
    expect(audit.body.length).toBeGreaterThanOrEqual(3)
    expect(audit.body.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['created', 'updated']),
    )
    expect(audit.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'created',
          actor_name: login.body.teacher_name,
        }),
        expect.objectContaining({
          action: 'updated',
          actor_name: null,
          changes: expect.arrayContaining([expect.objectContaining({ label: 'Access requests' })]),
        }),
        expect.objectContaining({
          action: 'updated',
          actor_name: login.body.teacher_name,
          changes: expect.arrayContaining([
            expect.objectContaining({ label: 'Prompt' }),
            expect.objectContaining({ label: 'Rules' }),
            expect.objectContaining({ label: 'Writing defaults' }),
            expect.objectContaining({ label: 'Browser policy' }),
          ]),
        }),
      ]),
    )
  })

  it('logs a student assignment-open attempt so the teacher can see it even if the student quits immediately', async () => {
    const joinCode = `TRY${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Attempt Logging ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Attempt Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        course: classroom.body.name,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Opening this should leave a teacher-visible trace.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const opened = await request(
      'POST',
      `/api/edu/student/assignments/${assignment.body.id}/open`,
      {
        join_code: joinCode,
        student_name: 'Ada Lovelace',
      },
    )
    expect(opened.status).toBe(201)

    const audit = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/audit`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(audit.status).toBe(200)
    expect(audit.body.length).toBeGreaterThanOrEqual(2)
    expect(audit.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_name: null,
          summary: expect.stringMatching(/Ada Lovelace|opened|attempt/i),
        }),
      ]),
    )
  })

  it('replaces prior grading cleanly when the teacher clears rubric marks and annotations on a later pass', async () => {
    const joinCode = `CLR${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Feedback Studio ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Feedback Replacement ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Draft and revise the paragraph.',
        rubric: [
          { id: 'claim', title: 'Claim', points: 4, description: 'Clear and specific.' },
          { id: 'evidence', title: 'Evidence', points: 4, description: 'Supports the claim.' },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const sessionId = `live:${randomUUID()}`
    const published = await request('POST', '/api/edu/live-sessions', {
      id: sessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'A first paragraph with room to improve.',
      document_history: [{ t: 120, pos: 0, del: '', ins: 'A first paragraph with room to improve.' }],
      last_activity_at: '2026-04-29T01:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(published.status).toBe(201)

    const firstGrade = await request(
      'PUT',
      `/api/edu/live-sessions/${sessionId}/grading`,
      {
        teacher_comment: 'Add a sharper claim and another piece of evidence.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 72,
        rubric_scores: { claim: 2, evidence: 1 },
        inline_annotations: [
          {
            id: 'annotation-1',
            type: 'comment',
            start: 2,
            end: 15,
            quote: 'first paragraph',
            note: 'This needs to be more specific.',
            replacement: '',
            created_at: '2026-04-29T01:02:00.000Z',
            updated_at: '2026-04-29T01:02:00.000Z',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(firstGrade.status).toBe(200)

    const afterFirstGrade = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterFirstGrade.status).toBe(200)
    expect(afterFirstGrade.body.assignment.student_feedback).toMatchObject({
      teacher_comment: 'Add a sharper claim and another piece of evidence.',
      returned_for_revision: true,
      grade_label: 'Revise',
      grade_score: '72',
      rubric_scores: { claim: 2, evidence: 1 },
    })
    expect(afterFirstGrade.body.assignment.student_feedback.inline_annotations).toHaveLength(1)

    const secondGrade = await request(
      'PUT',
      `/api/edu/live-sessions/${sessionId}/grading`,
      {
        teacher_comment: 'Much better. Ready to submit.',
        returned_for_revision: false,
        grade_label: 'Ready',
        grade_score: 91,
        rubric_scores: {},
        inline_annotations: [],
      },
      { Cookie: login.cookie },
    )
    expect(secondGrade.status).toBe(200)

    const afterSecondGrade = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterSecondGrade.status).toBe(200)
    expect(afterSecondGrade.body.assignment.student_feedback).toMatchObject({
      teacher_comment: 'Much better. Ready to submit.',
      returned_for_revision: false,
      grade_label: 'Ready',
      grade_score: '91',
      rubric_scores: {},
    })
    expect(afterSecondGrade.body.assignment.student_feedback.inline_annotations).toEqual([])
  })

  it('removes stripped assignment materials and policy state from the student view instead of leaving stale leftovers', async () => {
    const joinCode = `STR${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Cleanup Seminar ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const linked = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Source Notes ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        prompt: 'Source notes.',
      },
      { Cookie: login.cookie },
    )
    expect(linked.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Cleanup Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Use the packet and notes.',
        starter_document: '# Begin\n\nUse the packet before drafting.',
        linked_assignment_ids: [linked.body.id],
        policy: {
          allow_dictation: true,
          export_allowed: true,
          show_rubric_to_student: true,
        },
        editor_policy: {
          font_family: 'serif',
          font_size: 19,
          line_height: 'double',
          font_locked: true,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://reader.example.org/start',
          mode: 'whitelist',
          allowed_domains: ['reader.example.org'],
          blocked_domains: [],
          log_all_navigation: true,
        },
        reference_documents: [
          {
            id: 'packet-1',
            title: 'Source Packet',
            mime_type: 'application/pdf',
            data_url: 'data:application/pdf;base64,JVBERi0xLjQK',
            size_bytes: 2048,
          },
        ],
        rubric: [{ id: 'clarity', title: 'Clarity', description: 'Stay clear.', points: 4 }],
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const beforeStrip = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(beforeStrip.status).toBe(200)
    expect(beforeStrip.body.assignment).toMatchObject({
      starter_document: '# Begin\n\nUse the packet before drafting.',
      linked_assignment_ids: [linked.body.id],
      reference_documents: [expect.objectContaining({ id: 'packet-1', title: 'Source Packet' })],
      rubric: [expect.objectContaining({ id: 'clarity', title: 'Clarity' })],
    })
    expect(beforeStrip.body.assignment.policy).toMatchObject({
      allow_dictation: true,
      export_allowed: true,
      show_rubric_to_student: true,
    })
    expect(beforeStrip.body.assignment.editor_policy).toMatchObject({
      font_family: 'serif',
      font_size: 19,
      line_height: 'double',
      font_locked: true,
    })

    const stripped = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        prompt: 'Draft without the extra packet.',
        starter_document: '',
        linked_assignment_ids: [],
        policy: {
          allow_dictation: false,
          export_allowed: false,
          show_rubric_to_student: false,
        },
        editor_policy: {
          font_family: 'sans',
          font_size: 12,
          line_height: 'normal',
          font_locked: false,
        },
        browser_policy: {
          browser_enabled: false,
          home_url: '',
          mode: 'blacklist',
          allowed_domains: [],
          blocked_domains: ['reader.example.org'],
          log_all_navigation: false,
        },
        reference_documents: [],
        rubric: [],
      },
      { Cookie: login.cookie },
    )
    expect(stripped.status).toBe(200)

    const afterStrip = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterStrip.status).toBe(200)
    expect(afterStrip.body.assignment.starter_document).toBe('')
    expect(afterStrip.body.assignment.linked_assignment_ids).toEqual([])
    expect(afterStrip.body.assignment.reference_documents).toEqual([])
    expect(afterStrip.body.assignment.rubric).toEqual([])
    expect(afterStrip.body.assignment.policy).toMatchObject({
      allow_dictation: false,
      export_allowed: false,
      show_rubric_to_student: false,
    })
    expect(afterStrip.body.assignment.editor_policy).toMatchObject({
      font_family: 'sans',
      font_size: 12,
      line_height: 'double',
      font_locked: false,
    })
    expect(afterStrip.body.assignment.browser_policy).toMatchObject({
      browser_enabled: false,
      home_url: '',
      mode: 'blacklist',
    })
    expect(afterStrip.body.assignment.browser_policy.blocked_domains || []).toEqual([])
  })

  it('rejects a conflicting assignment retitle without corrupting existing teacher or student reads', async () => {
    const joinCode = `TIT${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Conflict Literature ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const firstAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Unique Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Original prompt for Ada.',
      },
      { Cookie: login.cookie },
    )
    expect(firstAssignment.status).toBe(201)

    const secondAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Conflicting Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Original prompt for the second assignment.',
      },
      { Cookie: login.cookie },
    )
    expect(secondAssignment.status).toBe(201)

    const rejectedUpdate = await request(
      'PUT',
      `/api/edu/assignments/${secondAssignment.body.id}`,
      {
        title: firstAssignment.body.title,
        prompt: 'This prompt should never stick.',
      },
      { Cookie: login.cookie },
    )
    expect(rejectedUpdate.status).toBe(409)
    expect(rejectedUpdate.body).toMatchObject({
      error: 'Assignment title already in use',
      title: firstAssignment.body.title,
    })

    const teacherRead = await request(
      'GET',
      `/api/edu/assignments/${secondAssignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherRead.status).toBe(200)
    expect(teacherRead.body).toMatchObject({
      id: secondAssignment.body.id,
      title: secondAssignment.body.title,
      prompt: 'Original prompt for the second assignment.',
    })

    const studentRead = await request(
      'GET',
      `/api/edu/student/assignments/${secondAssignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentRead.status).toBe(200)
    expect(studentRead.body.assignment).toMatchObject({
      id: secondAssignment.body.id,
      title: secondAssignment.body.title,
      prompt: 'Original prompt for the second assignment.',
    })

    const allAssignments = await request('GET', '/api/edu/assignments', undefined, {
      Cookie: login.cookie,
    })
    expect(allAssignments.status).toBe(200)
    expect(allAssignments.body.filter((item) => item.classroom_id === classroom.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstAssignment.body.id, title: firstAssignment.body.title }),
        expect.objectContaining({ id: secondAssignment.body.id, title: secondAssignment.body.title }),
      ]),
    )
  })

  it('keeps multi-student access requests and approvals isolated so one student can go live without leaking access to the other', async () => {
    const joinCode = `ISO${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Access Isolation ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Isolation Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        prompt: 'Write when approved.',
        schedule_windows: [
          {
            day: 'monday',
            start_time: '08:00',
            end_time: '08:30',
          },
        ],
        policy: {
          require_permission_to_rejoin: true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const adaRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'Need time to finish the conclusion.',
      },
    )
    const graceRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Grace Hopper',
        note: 'Need to reopen for a revision.',
      },
    )
    expect(adaRequest.status).toBe(201)
    expect(graceRequest.status).toBe(201)

    const approvedUntil = '2099-01-05T02:15:00.000Z'
    const approval = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_access_requests: {
          'grace hopper': {
            student_name: 'Grace Hopper',
            requested_at: graceRequest.body.student_access_request.requested_at,
            note: 'Need to reopen for a revision.',
          },
        },
        student_temporary_access_until: {
          'ada lovelace': approvedUntil,
        },
      },
      { Cookie: login.cookie },
    )
    expect(approval.status).toBe(200)

    const adaState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaState.status).toBe(200)
    expect(graceState.status).toBe(200)
    expect(adaState.body.assignment).toMatchObject({
      temporary_access_until: approvedUntil,
      access_revoked: false,
      student_access_request: null,
    })
    expect(graceState.body.assignment).toMatchObject({
      temporary_access_until: null,
      access_revoked: false,
      student_access_request: expect.objectContaining({
        student_name: 'Grace Hopper',
        note: 'Need to reopen for a revision.',
      }),
    })

    const liveSessionId = `live:${randomUUID()}`
    const livePublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'Ada got approved and kept writing.',
      document_history: [{ t: 180, pos: 0, del: '', ins: 'Ada got approved and kept writing.' }],
      last_activity_at: '2026-04-29T02:20:00.000Z',
      schedule_open: false,
      focused: true,
      hid_active: true,
    })
    expect(livePublish.status).toBe(201)

    const liveSummaries = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/live-summaries`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(liveSummaries.status).toBe(200)
    expect(liveSummaries.body.live_sessions).toHaveLength(1)
    expect(liveSummaries.body.live_sessions[0]).toMatchObject({
      student_name: 'Ada Lovelace',
      current_text: 'Ada got approved and kept writing.',
    })

    const dashboardDelta = await request(
      'GET',
      '/api/edu/dashboard/updates?since=',
      undefined,
      { Cookie: login.cookie },
    )
    expect(dashboardDelta.status).toBe(200)
    expect(JSON.stringify(dashboardDelta.body)).toContain('Ada Lovelace')
    expect(JSON.stringify(dashboardDelta.body)).toContain('Grace Hopper')
    expect(dashboardDelta.body.summary.live_sessions).toBeGreaterThanOrEqual(1)

    const allLiveSessions = await request('GET', '/api/edu/live-sessions', undefined, {
      Cookie: login.cookie,
    })
    expect(allLiveSessions.status).toBe(200)
    expect(
      allLiveSessions.body.filter((session) => session.assignment_id === assignment.body.id),
    ).toEqual([
      expect.objectContaining({
        student_name: 'Ada Lovelace',
        current_text: 'Ada got approved and kept writing.',
      }),
    ])
  })

  it('allows two student entries per assignment window, then requires teacher approval before the third entry', async () => {
    const joinCode = `RJN${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Rejoin Guard ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const alwaysOpenWindow = {
      label: 'Live test window',
      days: {
        sunday: true,
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
      },
      start_hour: 0,
      start_minute: 0,
      end_hour: 23,
      end_minute: 59,
    }
    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Rejoin Guard Essay ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Keep the test window calm.',
        windows: [alwaysOpenWindow],
        policy: {
          require_lockdown: false,
          require_permission_to_rejoin: true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const beforeFirstEntry = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(beforeFirstEntry.status).toBe(200)
    expect(beforeFirstEntry.body.assignment.access_revoked).toBe(false)

    const openFirst = await request('POST', `/api/edu/student/assignments/${assignment.body.id}/open`, {
      join_code: joinCode,
      student_name: 'Ada Lovelace',
    })
    expect(openFirst.status).toBe(201)
    expect(openFirst.body.access_revoked).toBe(false)
    expect(openFirst.body.entry_count).toBe(1)

    const afterFirstEntry = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterFirstEntry.status).toBe(200)
    expect(afterFirstEntry.body.assignment.access_revoked).toBe(false)

    const openSecond = await request('POST', `/api/edu/student/assignments/${assignment.body.id}/open`, {
      join_code: joinCode,
      student_name: 'Ada Lovelace',
    })
    expect(openSecond.status).toBe(201)
    expect(openSecond.body.access_revoked).toBe(false)
    expect(openSecond.body.entry_count).toBe(2)

    const blocked = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(blocked.status).toBe(200)
    expect(blocked.body).toMatchObject({
      schedule_open: false,
      assignment: {
        access_revoked: true,
        rejoin_history: expect.objectContaining({
          entry_count: 2,
          events: expect.arrayContaining([
            expect.objectContaining({ type: 'opened' }),
            expect.objectContaining({ type: 'locked' }),
          ]),
        }),
      },
    })

    const teacherAssignment = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherAssignment.status).toBe(200)
    expect(teacherAssignment.body.student_rejoin_history['ada lovelace']).toMatchObject({
      student_name: 'Ada Lovelace',
      entry_count: 2,
    })

    const editedTime = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        windows: [
          {
            ...alwaysOpenWindow,
            end_minute: 58,
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(editedTime.status).toBe(200)
    expect(editedTime.body.student_rejoin_history).toEqual({})
    expect(editedTime.body.student_access_revoked).toEqual({})

    const afterTimeEdit = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(afterTimeEdit.status).toBe(200)
    expect(afterTimeEdit.body.assignment.access_revoked).toBe(false)
  })

  it('deletes one classroom without disturbing another classroom for the same student or teacher dashboard', async () => {
    const doomedCode = `DEL${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const survivorCode = `SAV${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const doomedClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Delete Me ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: doomedCode,
      },
      { Cookie: login.cookie },
    )
    const survivorClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Keep Me ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: survivorCode,
      },
      { Cookie: login.cookie },
    )
    expect(doomedClassroom.status).toBe(201)
    expect(survivorClassroom.status).toBe(201)

    const doomedAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Doomed Assignment ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: doomedClassroom.body.id,
        classroom_name: doomedClassroom.body.name,
        course: doomedClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This class will be deleted.',
      },
      { Cookie: login.cookie },
    )
    const survivorAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Survivor Assignment ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: survivorClassroom.body.id,
        classroom_name: survivorClassroom.body.name,
        course: survivorClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This class should survive.',
      },
      { Cookie: login.cookie },
    )
    expect(doomedAssignment.status).toBe(201)
    expect(survivorAssignment.status).toBe(201)

    const doomedBefore = await request(
      'GET',
      `/api/edu/student/config?join_code=${doomedCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const survivorBefore = await request(
      'GET',
      `/api/edu/student/config?join_code=${survivorCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(doomedBefore.status).toBe(200)
    expect(survivorBefore.status).toBe(200)
    expect(doomedBefore.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: doomedAssignment.body.id })]),
    )
    expect(survivorBefore.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: survivorAssignment.body.id })]),
    )

    const deleted = await request(
      'DELETE',
      `/api/edu/classrooms/${doomedClassroom.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(deleted.status).toBe(200)

    const doomedAfter = await request(
      'GET',
      `/api/edu/student/config?join_code=${doomedCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const survivorAfter = await request(
      'GET',
      `/api/edu/student/config?join_code=${survivorCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(doomedAfter.status).toBe(200)
    expect(doomedAfter.body).toEqual({ classroom: null, canonical_student_name: null, assignments: [] })
    expect(survivorAfter.status).toBe(200)
    expect(survivorAfter.body.classroom).toMatchObject({ id: survivorClassroom.body.id })
    expect(survivorAfter.body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: survivorAssignment.body.id,
          title: survivorAssignment.body.title,
        }),
      ]),
    )

    const doomedAssignmentAfter = await request(
      'GET',
      `/api/edu/student/assignments/${doomedAssignment.body.id}?join_code=${doomedCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const survivorAssignmentAfter = await request(
      'GET',
      `/api/edu/student/assignments/${survivorAssignment.body.id}?join_code=${survivorCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(doomedAssignmentAfter.status).toBe(404)
    expect(survivorAssignmentAfter.status).toBe(200)
    expect(survivorAssignmentAfter.body.assignment).toMatchObject({
      id: survivorAssignment.body.id,
      prompt: 'This class should survive.',
    })

    const teacherAssignments = await request('GET', '/api/edu/assignments', undefined, {
      Cookie: login.cookie,
    })
    expect(teacherAssignments.status).toBe(200)
    expect(teacherAssignments.body.find((item) => item.id === doomedAssignment.body.id)).toBeFalsy()
    expect(teacherAssignments.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: survivorAssignment.body.id })]),
    )
  })

  it('rejects conflicting classroom renames without corrupting join-code based student routing for either class', async () => {
    const originalCode = `RNO${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const conflictingCode = `RNC${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const firstClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Rename Origin ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: originalCode,
      },
      { Cookie: login.cookie },
    )
    const secondClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Rename Conflict ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: conflictingCode,
      },
      { Cookie: login.cookie },
    )
    expect(firstClassroom.status).toBe(201)
    expect(secondClassroom.status).toBe(201)

    const firstAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Origin Essay ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: firstClassroom.body.id,
        classroom_name: firstClassroom.body.name,
        course: firstClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Original join-code route.',
      },
      { Cookie: login.cookie },
    )
    const secondAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Conflict Essay ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: secondClassroom.body.id,
        classroom_name: secondClassroom.body.name,
        course: secondClassroom.body.name,
        assigned_students: ['Grace Hopper'],
        prompt: 'Conflicting join-code route.',
      },
      { Cookie: login.cookie },
    )
    expect(firstAssignment.status).toBe(201)
    expect(secondAssignment.status).toBe(201)

    const rejectedRename = await request(
      'PUT',
      `/api/edu/classrooms/${secondClassroom.body.id}`,
      {
        name: 'This rename should fail cleanly',
        join_code: originalCode.toLowerCase(),
      },
      { Cookie: login.cookie },
    )
    expect(rejectedRename.status).toBe(409)
    expect(rejectedRename.body).toMatchObject({
      error: 'Join code already in use',
      join_code: originalCode,
    })

    const firstRoute = await request(
      'GET',
      `/api/edu/student/config?join_code=${originalCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const secondRoute = await request(
      'GET',
      `/api/edu/student/config?join_code=${conflictingCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(firstRoute.status).toBe(200)
    expect(secondRoute.status).toBe(200)
    expect(firstRoute.body.classroom).toMatchObject({
      id: firstClassroom.body.id,
      join_code: originalCode,
    })
    expect(secondRoute.body.classroom).toMatchObject({
      id: secondClassroom.body.id,
      join_code: conflictingCode,
    })
    expect(firstRoute.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstAssignment.body.id })]),
    )
    expect(secondRoute.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: secondAssignment.body.id })]),
    )

    const teacherSecondRead = await request(
      'GET',
      `/api/edu/classrooms/${secondClassroom.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherSecondRead.status).toBe(200)
    expect(teacherSecondRead.body).toMatchObject({
      id: secondClassroom.body.id,
      join_code: conflictingCode,
      name: secondClassroom.body.name,
    })
  })

  it('deletes one assignment without disturbing a sibling assignment, its student view, or saved feedback', async () => {
    const joinCode = `SIB${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Sibling Suite ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const firstAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Keep Me ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This assignment should survive the deletion of its neighbor.',
      },
      { Cookie: login.cookie },
    )
    const secondAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Delete Me ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This assignment will be deleted.',
      },
      { Cookie: login.cookie },
    )
    expect(firstAssignment.status).toBe(201)
    expect(secondAssignment.status).toBe(201)

    const liveSessionId = `live:${randomUUID()}`
    const livePublish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: firstAssignment.body.id,
      assignment_title: firstAssignment.body.title,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'Ada kept working in the surviving assignment.',
      document_history: [
        { t: 120, pos: 0, del: '', ins: 'Ada kept working in the surviving assignment.' },
      ],
      last_activity_at: '2026-04-29T03:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(livePublish.status).toBe(201)

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      {
        teacher_comment: 'Keep refining this stronger draft.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 84,
        rubric_scores: { focus: 3 },
        inline_annotations: [],
      },
      { Cookie: login.cookie },
    )
    expect(grading.status).toBe(200)

    const deleted = await request(
      'DELETE',
      `/api/edu/assignments/${secondAssignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(deleted.status).toBe(200)

    const studentConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body.assignments).toEqual([
      expect.objectContaining({
        id: firstAssignment.body.id,
        title: firstAssignment.body.title,
        student_feedback: expect.objectContaining({
          teacher_comment: 'Keep refining this stronger draft.',
          grade_label: 'Revise',
          grade_score: '84',
          rubric_scores: { focus: 3 },
        }),
      }),
    ])

    const deletedDetail = await request(
      'GET',
      `/api/edu/student/assignments/${secondAssignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(deletedDetail.status).toBe(404)

    const survivorDetail = await request(
      'GET',
      `/api/edu/student/assignments/${firstAssignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(survivorDetail.status).toBe(200)
    expect(survivorDetail.body.assignment).toMatchObject({
      id: firstAssignment.body.id,
      prompt: 'This assignment should survive the deletion of its neighbor.',
      student_feedback: expect.objectContaining({
        teacher_comment: 'Keep refining this stronger draft.',
      }),
    })

    const teacherAssignments = await request('GET', '/api/edu/assignments', undefined, {
      Cookie: login.cookie,
    })
    expect(teacherAssignments.status).toBe(200)
    expect(teacherAssignments.body.find((item) => item.id === secondAssignment.body.id)).toBeFalsy()
    expect(teacherAssignments.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstAssignment.body.id })]),
    )
  })

  it('rejects blank access requests without mutating assignment state or audit history', async () => {
    const joinCode = `BAD${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Validation Lab ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Validation Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Try the access request flow.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const rejected = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: '   ',
        note: 'This should fail and leave no trace.',
      },
    )
    expect(rejected.status).toBe(400)
    expect(rejected.body).toMatchObject({
      error: 'Student name is required',
    })

    const studentState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentState.status).toBe(200)
    expect(studentState.body.assignment).toMatchObject({
      student_access_request: null,
      access_revoked: false,
      temporary_access_until: null,
    })

    const teacherAssignment = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherAssignment.status).toBe(200)
    expect(teacherAssignment.body.student_access_requests).toEqual({})

    const audit = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/audit`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(audit.status).toBe(200)
    expect(audit.body).toHaveLength(1)
    expect(audit.body[0]).toMatchObject({
      action: 'created',
      actor_name: login.body.teacher_name,
    })
  })

  it('rejects unauthorized grading updates without mutating the student-visible feedback', async () => {
    const joinCode = `AUT${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Auth Guard ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Protected Feedback ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Teacher feedback should not be overwritten by unauthorized requests.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = `live:${randomUUID()}`
    const published = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'Protected draft text.',
      document_history: [{ t: 100, pos: 0, del: '', ins: 'Protected draft text.' }],
      last_activity_at: '2026-04-29T03:30:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(published.status).toBe(201)

    const authorizedGrade = await request(
      'PUT',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      {
        teacher_comment: 'Real feedback from the teacher.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 79,
        rubric_scores: { claim: 2 },
        inline_annotations: [],
      },
      { Cookie: login.cookie },
    )
    expect(authorizedGrade.status).toBe(200)

    const rejectedOverwrite = await request(
      'PUT',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      {
        teacher_comment: 'This should never land.',
        returned_for_revision: false,
        grade_label: 'A',
        grade_score: 100,
        rubric_scores: { claim: 4 },
        inline_annotations: [],
      },
      { Cookie: '' },
    )
    expect(rejectedOverwrite.status).toBe(401)

    const studentState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentState.status).toBe(200)
    expect(studentState.body.assignment.student_feedback).toMatchObject({
      teacher_comment: 'Real feedback from the teacher.',
      returned_for_revision: true,
      grade_label: 'Revise',
      grade_score: '79',
      rubric_scores: { claim: 2 },
    })
  })

  it('rejects conflicting classroom name renames without disturbing student routing or teacher reads', async () => {
    const firstCode = `NAM${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const secondCode = `NMB${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const firstClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Name Origin ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: firstCode,
      },
      { Cookie: login.cookie },
    )
    const secondClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Name Conflict ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: secondCode,
      },
      { Cookie: login.cookie },
    )
    expect(firstClassroom.status).toBe(201)
    expect(secondClassroom.status).toBe(201)

    const firstAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Name Origin Essay ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: firstClassroom.body.id,
        classroom_name: firstClassroom.body.name,
        course: firstClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'First classroom route.',
      },
      { Cookie: login.cookie },
    )
    const secondAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Name Conflict Essay ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: secondClassroom.body.id,
        classroom_name: secondClassroom.body.name,
        course: secondClassroom.body.name,
        assigned_students: ['Grace Hopper'],
        prompt: 'Second classroom route.',
      },
      { Cookie: login.cookie },
    )
    expect(firstAssignment.status).toBe(201)
    expect(secondAssignment.status).toBe(201)

    const rejectedRename = await request(
      'PUT',
      `/api/edu/classrooms/${secondClassroom.body.id}`,
      {
        name: firstClassroom.body.name,
      },
      { Cookie: login.cookie },
    )
    expect(rejectedRename.status).toBe(409)
    expect(rejectedRename.body).toMatchObject({
      error: 'Classroom name already in use',
      name: firstClassroom.body.name,
    })

    const firstRoute = await request(
      'GET',
      `/api/edu/student/config?join_code=${firstCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const secondRoute = await request(
      'GET',
      `/api/edu/student/config?join_code=${secondCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(firstRoute.status).toBe(200)
    expect(secondRoute.status).toBe(200)
    expect(firstRoute.body.classroom).toMatchObject({
      id: firstClassroom.body.id,
      name: firstClassroom.body.name,
      join_code: firstCode,
    })
    expect(secondRoute.body.classroom).toMatchObject({
      id: secondClassroom.body.id,
      name: secondClassroom.body.name,
      join_code: secondCode,
    })
    expect(firstRoute.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstAssignment.body.id })]),
    )
    expect(secondRoute.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: secondAssignment.body.id })]),
    )

    const teacherSecondRead = await request(
      'GET',
      `/api/edu/classrooms/${secondClassroom.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherSecondRead.status).toBe(200)
    expect(teacherSecondRead.body).toMatchObject({
      id: secondClassroom.body.id,
      name: secondClassroom.body.name,
      join_code: secondCode,
    })
  })

  it('rejects unauthorized assignment deletion without disturbing teacher or student state', async () => {
    const joinCode = `UDEL${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`
    const email = `teacher+${randomUUID()}@edu.handtyped.app`
    const password = 'handtyped-edu'

    const signup = await teacherSignup({
      name: 'Unauthorized Delete Teacher',
      email,
      password,
    })
    expect(signup.status).toBe(201)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Unauthorized Delete ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Unauthorized Delete Teacher',
        join_code: joinCode,
      },
      { Cookie: signup.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Protected Delete ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This assignment should survive a rejected delete.',
      },
      { Cookie: signup.cookie },
    )
    expect(assignment.status).toBe(201)

    const logout = await request('POST', '/api/edu/auth/logout', undefined, {
      Cookie: signup.cookie,
    })
    expect(logout.status).toBe(200)

    const rejectedDelete = await request(
      'DELETE',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: signup.cookie },
    )
    expect(rejectedDelete.status).toBe(401)

    const relogin = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'password',
        email,
        password,
      }),
    })
    const reloginCookie = relogin.headers.get('set-cookie') || ''
    expect(relogin.status).toBe(200)

    const teacherRead = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: reloginCookie },
    )
    expect(teacherRead.status).toBe(200)
    expect(teacherRead.body).toMatchObject({
      id: assignment.body.id,
      prompt: 'This assignment should survive a rejected delete.',
    })

    const studentConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignment.body.id })]),
    )

    const audit = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/audit`,
      undefined,
      { Cookie: reloginCookie },
    )
    expect(audit.status).toBe(200)
    expect(audit.body).toHaveLength(1)
    expect(audit.body[0]).toMatchObject({
      action: 'created',
      actor_email: email,
    })
  })

  it('repeats a student access request by replacing the existing request instead of duplicating or leaking it', async () => {
    const joinCode = `REQ${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Repeated Request ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Repeated Request Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        prompt: 'Request access more than once.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const firstRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'First request note.',
      },
    )
    expect(firstRequest.status).toBe(201)

    const secondRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'Updated request note.',
      },
    )
    expect(secondRequest.status).toBe(201)
    expect(secondRequest.body.student_access_request).toMatchObject({
      student_name: 'Ada Lovelace',
      note: 'Updated request note.',
    })

    const graceRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Grace Hopper',
        note: 'Grace still needs access too.',
      },
    )
    expect(graceRequest.status).toBe(201)

    const teacherRead = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(teacherRead.status).toBe(200)
    expect(teacherRead.body.student_access_requests).toMatchObject({
      'ada lovelace': expect.objectContaining({
        student_name: 'Ada Lovelace',
        note: 'Updated request note.',
      }),
      'grace hopper': expect.objectContaining({
        student_name: 'Grace Hopper',
        note: 'Grace still needs access too.',
      }),
    })
    expect(Object.keys(teacherRead.body.student_access_requests)).toHaveLength(2)

    const adaStudentState = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(adaStudentState.status).toBe(200)
    expect(adaStudentState.body.assignment.student_access_request).toMatchObject({
      student_name: 'Ada Lovelace',
      note: 'Updated request note.',
    })

    const audit = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/audit`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(audit.status).toBe(200)
    expect(
      audit.body.filter(
        (entry) =>
          entry.action === 'updated' &&
          entry.actor_name == null &&
          entry.changes?.some?.((change) => change.label === 'Access requests'),
      ),
    ).toHaveLength(3)
  })

  it('rejects duplicate assignment title creation without disturbing the original assignment or student reads', async () => {
    const joinCode = `DUP${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Duplicate Title ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const originalAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Protected Title ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'The original assignment should survive.',
      },
      { Cookie: login.cookie },
    )
    expect(originalAssignment.status).toBe(201)

    const rejectedDuplicate = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: originalAssignment.body.title,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Grace Hopper'],
        prompt: 'This duplicate should be rejected.',
      },
      { Cookie: login.cookie },
    )
    expect(rejectedDuplicate.status).toBe(409)
    expect(rejectedDuplicate.body).toMatchObject({
      error: 'Assignment title already in use',
      title: originalAssignment.body.title,
    })

    const teacherAssignments = await request('GET', '/api/edu/assignments', undefined, {
      Cookie: login.cookie,
    })
    expect(teacherAssignments.status).toBe(200)
    expect(
      teacherAssignments.body.filter((item) => item.title === originalAssignment.body.title),
    ).toHaveLength(1)

    const adaConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaConfig.status).toBe(200)
    expect(graceConfig.status).toBe(200)
    expect(adaConfig.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: originalAssignment.body.id })]),
    )
    expect(graceConfig.body.assignments).toEqual([])

    const audit = await request(
      'GET',
      `/api/edu/assignments/${originalAssignment.body.id}/audit`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(audit.status).toBe(200)
    expect(audit.body).toHaveLength(1)
    expect(audit.body[0]).toMatchObject({
      action: 'created',
      assignment_id: originalAssignment.body.id,
    })
  })

  it('rejects unauthorized classroom updates without disturbing class routing or attached assignments', async () => {
    const joinCode = `UCLS${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`
    const email = `teacher+${randomUUID()}@edu.handtyped.app`
    const password = 'handtyped-edu'

    const signup = await teacherSignup({
      name: 'Unauthorized Classroom Teacher',
      email,
      password,
    })
    expect(signup.status).toBe(201)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Protected Classroom ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Unauthorized Classroom Teacher',
        join_code: joinCode,
      },
      { Cookie: signup.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Classroom Guard ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Attached assignment should stay routed here.',
      },
      { Cookie: signup.cookie },
    )
    expect(assignment.status).toBe(201)

    const logout = await request('POST', '/api/edu/auth/logout', undefined, {
      Cookie: signup.cookie,
    })
    expect(logout.status).toBe(200)

    const rejectedUpdate = await request(
      'PUT',
      `/api/edu/classrooms/${classroom.body.id}`,
      {
        name: 'Hacked Name',
        join_code: 'ZZZZZZ',
      },
      { Cookie: signup.cookie },
    )
    expect(rejectedUpdate.status).toBe(401)

    const relogin = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'password',
        email,
        password,
      }),
    })
    const reloginCookie = relogin.headers.get('set-cookie') || ''
    expect(relogin.status).toBe(200)

    const teacherRead = await request(
      'GET',
      `/api/edu/classrooms/${classroom.body.id}`,
      undefined,
      { Cookie: reloginCookie },
    )
    expect(teacherRead.status).toBe(200)
    expect(teacherRead.body).toMatchObject({
      id: classroom.body.id,
      name: classroom.body.name,
      join_code: joinCode,
    })

    const studentConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body.classroom).toMatchObject({
      id: classroom.body.id,
      name: classroom.body.name,
      join_code: joinCode,
    })
    expect(studentConfig.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignment.body.id })]),
    )

    const badJoinCodeConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=ZZZZZZ&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(badJoinCodeConfig.status).toBe(200)
    expect(badJoinCodeConfig.body).toEqual({ classroom: null, canonical_student_name: null, assignments: [] })
  })

  it('rejects unauthorized classroom deletion without disturbing teacher reads, student routing, or attached assignments', async () => {
    const joinCode = `UCD${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const email = `teacher+${randomUUID()}@edu.handtyped.app`
    const password = 'handtyped-edu'

    const signup = await teacherSignup({
      name: 'Unauthorized Classroom Delete Teacher',
      email,
      password,
    })
    expect(signup.status).toBe(201)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Protected Delete Class ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Unauthorized Classroom Delete Teacher',
        join_code: joinCode,
      },
      { Cookie: signup.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Protected Delete Assignment ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This classroom and assignment should survive a rejected delete.',
      },
      { Cookie: signup.cookie },
    )
    expect(assignment.status).toBe(201)

    const logout = await request('POST', '/api/edu/auth/logout', undefined, {
      Cookie: signup.cookie,
    })
    expect(logout.status).toBe(200)

    const rejectedDelete = await request(
      'DELETE',
      `/api/edu/classrooms/${classroom.body.id}`,
      undefined,
      { Cookie: signup.cookie },
    )
    expect(rejectedDelete.status).toBe(401)

    const relogin = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'password',
        email,
        password,
      }),
    })
    const reloginCookie = relogin.headers.get('set-cookie') || ''
    expect(relogin.status).toBe(200)

    const teacherClassroom = await request(
      'GET',
      `/api/edu/classrooms/${classroom.body.id}`,
      undefined,
      { Cookie: reloginCookie },
    )
    expect(teacherClassroom.status).toBe(200)
    expect(teacherClassroom.body).toMatchObject({
      id: classroom.body.id,
      name: classroom.body.name,
      join_code: joinCode,
    })

    const teacherAssignments = await request('GET', '/api/edu/assignments', undefined, {
      Cookie: reloginCookie,
    })
    expect(teacherAssignments.status).toBe(200)
    expect(teacherAssignments.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignment.body.id })]),
    )

    const studentConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body.classroom).toMatchObject({
      id: classroom.body.id,
      name: classroom.body.name,
    })
    expect(studentConfig.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignment.body.id })]),
    )
  })

  it('rejects duplicate teacher signup without creating a second account or breaking the original login', async () => {
    const email = `teacher+${randomUUID()}@edu.handtyped.app`
    const password = 'handtyped-edu'

    const firstSignup = await teacherSignup({
      name: 'Duplicate Signup Teacher',
      email,
      password,
    })
    expect(firstSignup.status).toBe(201)

    const duplicateSignup = await teacherSignup({
      name: 'Duplicate Signup Teacher Again',
      email,
      password,
    })
    expect(duplicateSignup.status).toBe(400)
    expect(duplicateSignup.body).toMatchObject({
      error: 'A teacher account with that email already exists',
      authenticated: false,
    })

    const login = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'password',
        email,
        password,
      }),
    })
    const cookie = login.headers.get('set-cookie') || ''
    const body = await login.json().catch(() => null)
    expect(login.status).toBe(200)
    expect(body).toMatchObject({
      authenticated: true,
      teacher_email: email,
      teacher_name: 'Duplicate Signup Teacher',
    })

    const session = await request('GET', '/api/edu/auth/session', undefined, {
      Cookie: cookie,
    })
    expect(session.status).toBe(200)
    expect(session.body).toMatchObject({
      authenticated: true,
      teacher_email: email,
      teacher_name: 'Duplicate Signup Teacher',
    })
  })

  it('rejects unauthorized assignment updates without disturbing teacher reads, student routing, or audit history', async () => {
    const joinCode = `UAS${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const email = `teacher+${randomUUID()}@edu.handtyped.app`
    const password = 'handtyped-edu'

    const signup = await teacherSignup({
      name: 'Unauthorized Assignment Update Teacher',
      email,
      password,
    })
    expect(signup.status).toBe(201)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Assignment Guard ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Unauthorized Assignment Update Teacher',
        join_code: joinCode,
      },
      { Cookie: signup.cookie },
    )
    expect(classroom.status).toBe(201)

    const assignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Locked Assignment ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This assignment should not change after a rejected update.',
      },
      { Cookie: signup.cookie },
    )
    expect(assignment.status).toBe(201)

    const logout = await request('POST', '/api/edu/auth/logout', undefined, {
      Cookie: signup.cookie,
    })
    expect(logout.status).toBe(200)

    const rejectedUpdate = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        title: 'Hacked Title',
        prompt: 'This prompt should never stick.',
      },
      { Cookie: signup.cookie },
    )
    expect(rejectedUpdate.status).toBe(401)

    const relogin = await fetch(`${baseUrl}/api/edu/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'password',
        email,
        password,
      }),
    })
    const reloginCookie = relogin.headers.get('set-cookie') || ''
    expect(relogin.status).toBe(200)

    const teacherRead = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: reloginCookie },
    )
    expect(teacherRead.status).toBe(200)
    expect(teacherRead.body).toMatchObject({
      id: assignment.body.id,
      title: assignment.body.title,
      prompt: 'This assignment should not change after a rejected update.',
    })

    const studentRead = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentRead.status).toBe(200)
    expect(studentRead.body.assignment).toMatchObject({
      id: assignment.body.id,
      title: assignment.body.title,
      prompt: 'This assignment should not change after a rejected update.',
    })

    const audit = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}/audit`,
      undefined,
      { Cookie: reloginCookie },
    )
    expect(audit.status).toBe(200)
    expect(audit.body).toHaveLength(1)
    expect(audit.body[0]).toMatchObject({
      action: 'created',
      actor_email: email,
    })
  })

  it('rejects duplicate classroom-name creation without disturbing the original class or student routing', async () => {
    const firstCode = `DCN${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const secondCode = `DCO${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const firstClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Protected Name ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: firstCode,
      },
      { Cookie: login.cookie },
    )
    expect(firstClassroom.status).toBe(201)

    const firstAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Protected Name Essay ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: firstClassroom.body.id,
        classroom_name: firstClassroom.body.name,
        course: firstClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'The original classroom route should remain intact.',
      },
      { Cookie: login.cookie },
    )
    expect(firstAssignment.status).toBe(201)

    const rejectedCreate = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: firstClassroom.body.name,
        teacher_name: 'Ms. Keating',
        join_code: secondCode,
      },
      { Cookie: login.cookie },
    )
    expect(rejectedCreate.status).toBe(409)
    expect(rejectedCreate.body).toMatchObject({
      error: 'Classroom name already in use',
      name: firstClassroom.body.name,
    })

    const teacherClassrooms = await request('GET', '/api/edu/classrooms', undefined, {
      Cookie: login.cookie,
    })
    expect(teacherClassrooms.status).toBe(200)
    expect(
      teacherClassrooms.body.filter((item) => item.name === firstClassroom.body.name),
    ).toHaveLength(1)

    const originalRoute = await request(
      'GET',
      `/api/edu/student/config?join_code=${firstCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const rejectedRoute = await request(
      'GET',
      `/api/edu/student/config?join_code=${secondCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(originalRoute.status).toBe(200)
    expect(rejectedRoute.status).toBe(200)
    expect(originalRoute.body.classroom).toMatchObject({
      id: firstClassroom.body.id,
      name: firstClassroom.body.name,
      join_code: firstCode,
    })
    expect(originalRoute.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstAssignment.body.id })]),
    )
    expect(rejectedRoute.body).toEqual({ classroom: null, canonical_student_name: null, assignments: [] })
  })

  it('deletes a classroom with multiple assignments by removing all of its student and teacher-visible work while leaving another classroom intact', async () => {
    const doomedCode = `MDL${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const survivorCode = `MSV${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const doomedClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Cascade Delete ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: doomedCode,
      },
      { Cookie: login.cookie },
    )
    const survivorClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Cascade Survivor ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: survivorCode,
      },
      { Cookie: login.cookie },
    )
    expect(doomedClassroom.status).toBe(201)
    expect(survivorClassroom.status).toBe(201)

    const doomedFirst = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Doomed First ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: doomedClassroom.body.id,
        classroom_name: doomedClassroom.body.name,
        course: doomedClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'First doomed assignment.',
      },
      { Cookie: login.cookie },
    )
    const doomedSecond = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Doomed Second ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: doomedClassroom.body.id,
        classroom_name: doomedClassroom.body.name,
        course: doomedClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Second doomed assignment.',
      },
      { Cookie: login.cookie },
    )
    const survivorAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Survivor Keep ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: survivorClassroom.body.id,
        classroom_name: survivorClassroom.body.name,
        course: survivorClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This assignment should remain.',
      },
      { Cookie: login.cookie },
    )
    expect(doomedFirst.status).toBe(201)
    expect(doomedSecond.status).toBe(201)
    expect(survivorAssignment.status).toBe(201)

    const deleteClassroom = await request(
      'DELETE',
      `/api/edu/classrooms/${doomedClassroom.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(deleteClassroom.status).toBe(200)

    const doomedConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${doomedCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const survivorConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${survivorCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(doomedConfig.status).toBe(200)
    expect(doomedConfig.body).toEqual({ classroom: null, canonical_student_name: null, assignments: [] })
    expect(survivorConfig.status).toBe(200)
    expect(survivorConfig.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: survivorAssignment.body.id })]),
    )

    for (const deletedAssignmentId of [doomedFirst.body.id, doomedSecond.body.id]) {
      const deletedDetail = await request(
        'GET',
        `/api/edu/student/assignments/${deletedAssignmentId}?join_code=${doomedCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
      )
      expect(deletedDetail.status).toBe(404)
    }

    const teacherAssignments = await request('GET', '/api/edu/assignments', undefined, {
      Cookie: login.cookie,
    })
    expect(teacherAssignments.status).toBe(200)
    expect(
      teacherAssignments.body.find((item) => item.id === doomedFirst.body.id || item.id === doomedSecond.body.id),
    ).toBeFalsy()
    expect(teacherAssignments.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: survivorAssignment.body.id })]),
    )
  })

  it('rejects duplicate join-code creation without disturbing the original classroom route or its attached assignment', async () => {
    const originalCode = `JCA${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const originalClassroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Original Join Code ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: originalCode,
      },
      { Cookie: login.cookie },
    )
    expect(originalClassroom.status).toBe(201)

    const originalAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Join Code Essay ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: originalClassroom.body.id,
        classroom_name: originalClassroom.body.name,
        course: originalClassroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Original join-code route should stay stable.',
      },
      { Cookie: login.cookie },
    )
    expect(originalAssignment.status).toBe(201)

    const rejectedDuplicate = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Duplicate Join Code ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: originalCode.toLowerCase(),
      },
      { Cookie: login.cookie },
    )
    expect(rejectedDuplicate.status).toBe(409)
    expect(rejectedDuplicate.body).toMatchObject({
      error: 'Join code already in use',
      join_code: originalCode,
    })

    const teacherClassrooms = await request('GET', '/api/edu/classrooms', undefined, {
      Cookie: login.cookie,
    })
    expect(teacherClassrooms.status).toBe(200)
    expect(
      teacherClassrooms.body.filter((item) => item.join_code === originalCode),
    ).toHaveLength(1)

    const studentConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${originalCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentConfig.status).toBe(200)
    expect(studentConfig.body.classroom).toMatchObject({
      id: originalClassroom.body.id,
      join_code: originalCode,
    })
    expect(studentConfig.body.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: originalAssignment.body.id })]),
    )
  })

  it('keeps grading and student-visible feedback isolated between two assignments for the same student', async () => {
    const joinCode = `ISO${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Feedback Isolation ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const firstAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Feedback First ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Only this assignment should get the feedback.',
      },
      { Cookie: login.cookie },
    )
    const secondAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Feedback Second ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This sibling assignment should stay untouched.',
      },
      { Cookie: login.cookie },
    )
    expect(firstAssignment.status).toBe(201)
    expect(secondAssignment.status).toBe(201)

    const firstSessionId = `live:${randomUUID()}`
    const secondSessionId = `live:${randomUUID()}`
    expect(
      (
        await request('POST', '/api/edu/live-sessions', {
          id: firstSessionId,
          assignment_id: firstAssignment.body.id,
          assignment_title: firstAssignment.body.title,
          classroom: classroom.body.name,
          student_name: 'Ada Lovelace',
          current_text: 'First assignment draft.',
          document_history: [{ t: 100, pos: 0, del: '', ins: 'First assignment draft.' }],
          last_activity_at: '2026-04-29T04:00:00.000Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await request('POST', '/api/edu/live-sessions', {
          id: secondSessionId,
          assignment_id: secondAssignment.body.id,
          assignment_title: secondAssignment.body.title,
          classroom: classroom.body.name,
          student_name: 'Ada Lovelace',
          current_text: 'Second assignment draft.',
          document_history: [{ t: 120, pos: 0, del: '', ins: 'Second assignment draft.' }],
          last_activity_at: '2026-04-29T04:01:00.000Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
        })
      ).status,
    ).toBe(201)

    const graded = await request(
      'PUT',
      `/api/edu/live-sessions/${firstSessionId}/grading`,
      {
        teacher_comment: 'Only the first assignment should show this.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 81,
        rubric_scores: { focus: 3 },
        inline_annotations: [],
      },
      { Cookie: login.cookie },
    )
    expect(graded.status).toBe(200)

    const firstStudentView = await request(
      'GET',
      `/api/edu/student/assignments/${firstAssignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const secondStudentView = await request(
      'GET',
      `/api/edu/student/assignments/${secondAssignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(firstStudentView.status).toBe(200)
    expect(secondStudentView.status).toBe(200)
    expect(firstStudentView.body.assignment.student_feedback).toMatchObject({
      teacher_comment: 'Only the first assignment should show this.',
      returned_for_revision: true,
      grade_label: 'Revise',
      grade_score: '81',
      rubric_scores: { focus: 3 },
    })
    expect(secondStudentView.body.assignment.student_feedback).toBeNull()

    const config = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(config.status).toBe(200)
    expect(
      config.body.assignments.find((item) => item.id === firstAssignment.body.id)?.student_feedback,
    ).toMatchObject({
      teacher_comment: 'Only the first assignment should show this.',
    })
    expect(
      config.body.assignments.find((item) => item.id === secondAssignment.body.id)?.student_feedback ?? null,
    ).toBeNull()
  })

  it('revokes access for one student without leaking the revocation to a classmate on the same assignment', async () => {
    const joinCode = `RVK${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Revocation Isolation ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Revocation Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        prompt: 'Only Grace should be revoked.',
        student_temporary_access_until: {
          'ada lovelace': '2099-01-06T01:00:00.000Z',
          'grace hopper': '2099-01-06T01:00:00.000Z',
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const revoked = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_temporary_access_until: {
          'ada lovelace': '2099-01-06T01:00:00.000Z',
          'grace hopper': '2099-01-06T01:00:00.000Z',
        },
        student_access_revoked: {
          'grace hopper': true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(revoked.status).toBe(200)

    const adaView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaView.status).toBe(200)
    expect(graceView.status).toBe(200)
    expect(adaView.body.assignment).toMatchObject({
      access_revoked: false,
      temporary_access_until: '2099-01-06T01:00:00.000Z',
    })
    expect(graceView.body.assignment).toMatchObject({
      access_revoked: true,
      temporary_access_until: '2099-01-06T01:00:00.000Z',
    })
  })

  it('retargets an assignment from one student to the whole class without leaking the original student feedback to classmates', async () => {
    const joinCode = `TGT${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Retarget Feedback ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Retargeted Feedback Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Starts Ada-only, then opens to everyone.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const adaSessionId = `live:${randomUUID()}`
    expect(
      (
        await request('POST', '/api/edu/live-sessions', {
          id: adaSessionId,
          assignment_id: assignment.body.id,
          assignment_title: assignment.body.title,
          classroom: classroom.body.name,
          student_name: 'Ada Lovelace',
          current_text: 'Ada received teacher feedback first.',
          document_history: [{ t: 100, pos: 0, del: '', ins: 'Ada received teacher feedback first.' }],
          last_activity_at: '2026-04-29T05:00:00.000Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
        })
      ).status,
    ).toBe(201)

    const graded = await request(
      'PUT',
      `/api/edu/live-sessions/${adaSessionId}/grading`,
      {
        teacher_comment: 'This feedback belongs only to Ada.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 77,
        rubric_scores: { clarity: 2 },
        inline_annotations: [],
      },
      { Cookie: login.cookie },
    )
    expect(graded.status).toBe(200)

    const widened = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        assigned_students: [],
        prompt: 'Now open to the whole class.',
      },
      { Cookie: login.cookie },
    )
    expect(widened.status).toBe(200)

    const adaView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaView.status).toBe(200)
    expect(graceView.status).toBe(200)
    expect(adaView.body.assignment).toMatchObject({
      prompt: 'Now open to the whole class.',
      student_feedback: expect.objectContaining({
        teacher_comment: 'This feedback belongs only to Ada.',
        grade_label: 'Revise',
        grade_score: '77',
      }),
    })
    expect(graceView.body.assignment).toMatchObject({
      prompt: 'Now open to the whole class.',
      student_feedback: null,
    })
  })

  it('clears one student approval without wiping another students pending request on the same assignment', async () => {
    const joinCode = `APR${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Approval Isolation ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Approval Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        prompt: 'One approval should clear cleanly.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const adaRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Ada Lovelace',
        note: 'Ada needs extra time.',
      },
    )
    const graceRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Grace Hopper',
        note: 'Grace is still waiting.',
      },
    )
    expect(adaRequest.status).toBe(201)
    expect(graceRequest.status).toBe(201)

    const approvedUntil = '2099-01-07T01:30:00.000Z'
    const approved = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_access_requests: {
          'grace hopper': {
            student_name: 'Grace Hopper',
            requested_at: graceRequest.body.student_access_request.requested_at,
            note: 'Grace is still waiting.',
          },
        },
        student_temporary_access_until: {
          'ada lovelace': approvedUntil,
        },
      },
      { Cookie: login.cookie },
    )
    expect(approved.status).toBe(200)

    const cleared = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_access_requests: {
          'grace hopper': {
            student_name: 'Grace Hopper',
            requested_at: graceRequest.body.student_access_request.requested_at,
            note: 'Grace is still waiting.',
          },
        },
        student_temporary_access_until: {},
      },
      { Cookie: login.cookie },
    )
    expect(cleared.status).toBe(200)

    const adaView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaView.status).toBe(200)
    expect(graceView.status).toBe(200)
    expect(adaView.body.assignment).toMatchObject({
      temporary_access_until: null,
      student_access_request: null,
    })
    expect(graceView.body.assignment).toMatchObject({
      temporary_access_until: null,
      student_access_request: expect.objectContaining({
        student_name: 'Grace Hopper',
        note: 'Grace is still waiting.',
      }),
    })
  })

  it('narrows a whole-class assignment back to one student without leaving stale visibility or feedback for classmates', async () => {
    const joinCode = `NRW${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Narrow Visibility ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Whole Class Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: [],
        prompt: 'Everyone starts with this draft.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const initialAdaConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const initialGraceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(initialAdaConfig.status).toBe(200)
    expect(initialGraceConfig.status).toBe(200)
    expect(initialAdaConfig.body.assignments).toHaveLength(1)
    expect(initialGraceConfig.body.assignments).toHaveLength(1)

    const liveSessionId = `live:${randomUUID()}`
    const publish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'Ada kept working after the assignment opened to everyone.',
      document_history: [
        {
          t: 220,
          pos: 0,
          del: '',
          ins: 'Ada kept working after the assignment opened to everyone.',
        },
      ],
      last_activity_at: '2026-04-29T06:15:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(publish.status).toBe(201)

    const grade = await request(
      'PUT',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      {
        teacher_comment: 'Only Ada should keep this feedback.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 82,
        rubric_scores: { evidence: 3 },
        inline_annotations: [],
      },
      { Cookie: login.cookie },
    )
    expect(grade.status).toBe(200)

    const narrowed = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        assigned_students: ['Ada Lovelace'],
        prompt: 'The draft is now Ada-only.',
      },
      { Cookie: login.cookie },
    )
    expect(narrowed.status).toBe(200)

    const adaView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    const graceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )

    expect(adaView.status).toBe(200)
    expect(adaView.body.assignment).toMatchObject({
      prompt: 'The draft is now Ada-only.',
      student_feedback: expect.objectContaining({
        teacher_comment: 'Only Ada should keep this feedback.',
        grade_label: 'Revise',
        grade_score: '82',
      }),
    })
    expect(graceView.status).toBe(404)
    expect(graceConfig.status).toBe(200)
    expect(graceConfig.body.assignments).toEqual([])
  })

  it('clears a student-specific override back to the shared assignment defaults without leaving stale override state behind', async () => {
    const joinCode = `OVR${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Override Reset ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Override Reset Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        prompt: 'Overrides should clear cleanly.',
        policy: {
          allow_dictation: false,
          show_rubric_to_student: false,
          require_permission_to_rejoin: false,
        },
        editor_policy: {
          font_family: 'arial',
          font_size: 12,
          line_height: 'relaxed',
          font_locked: false,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://class.example.org/home',
          mode: 'whitelist',
          allowed_domains: ['class.example.org'],
        },
        student_overrides: {
          'ada lovelace': {
            student_name: 'Ada Lovelace',
            temporary_access_until: '2099-01-08T03:00:00.000Z',
            policy: {
              allow_dictation: true,
              show_rubric_to_student: true,
              require_permission_to_rejoin: true,
            },
            editor_policy: {
              font_family: 'mono',
              font_size: 30,
              line_height: 'double',
              font_locked: true,
            },
            browser_policy: {
              browser_enabled: false,
              home_url: 'https://ada.example.org/private',
              mode: 'blacklist',
              allowed_domains: ['ada.example.org'],
            },
          },
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const beforeClear = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(beforeClear.status).toBe(200)
    expect(beforeClear.body.assignment).toMatchObject({
      temporary_access_until: '2099-01-08T03:00:00.000Z',
      policy: {
        allow_dictation: true,
        show_rubric_to_student: true,
        require_permission_to_rejoin: true,
      },
      editor_policy: {
        font_family: 'mono',
        font_size: 30,
        line_height: 'double',
        font_locked: true,
      },
      browser_policy: {
        browser_enabled: false,
        home_url: 'https://ada.example.org/private',
        mode: 'blacklist',
        allowed_domains: ['ada.example.org'],
      },
    })

    const cleared = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        policy: {
          allow_dictation: true,
          show_rubric_to_student: false,
          require_permission_to_rejoin: false,
        },
        editor_policy: {
          font_family: 'totally-made-up-font',
          font_size: 18,
          line_height: 'single',
          font_locked: true,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://shared.example.org/library',
          mode: 'blacklist',
          allowed_domains: ['blocked.example.org'],
        },
        student_overrides: {},
      },
      { Cookie: login.cookie },
    )
    expect(cleared.status).toBe(200)

    const adaAfterClear = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceAfterClear = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaAfterClear.status).toBe(200)
    expect(graceAfterClear.status).toBe(200)
    expect(adaAfterClear.body.assignment).toMatchObject({
      temporary_access_until: null,
      policy: {
        allow_dictation: true,
        show_rubric_to_student: false,
        require_permission_to_rejoin: false,
      },
      editor_policy: {
        font_family: 'times',
        font_size: 18,
        line_height: 'single',
        font_locked: true,
      },
      browser_policy: {
        browser_enabled: true,
        home_url: 'https://shared.example.org/library',
        mode: 'blacklist',
        allowed_domains: ['blocked.example.org'],
      },
    })
    expect(graceAfterClear.body.assignment).toMatchObject({
      temporary_access_until: null,
      policy: {
        allow_dictation: true,
        show_rubric_to_student: false,
        require_permission_to_rejoin: false,
      },
      editor_policy: {
        font_family: 'times',
        font_size: 18,
        line_height: 'single',
        font_locked: true,
      },
      browser_policy: {
        browser_enabled: true,
        home_url: 'https://shared.example.org/library',
        mode: 'blacklist',
        allowed_domains: ['blocked.example.org'],
      },
    })
  })

  it('retargets an assignment from one named student to another without leaking the original students feedback or visibility', async () => {
    const joinCode = `SWP${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Student Swap ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Student Swap Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Starts with Ada, later moves to Grace.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = `live:${randomUUID()}`
    const publish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: 'Ada wrote the first version before the assignment moved.',
      document_history: [
        {
          t: 260,
          pos: 0,
          del: '',
          ins: 'Ada wrote the first version before the assignment moved.',
        },
      ],
      last_activity_at: '2026-04-29T07:00:00.000Z',
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(publish.status).toBe(201)

    const graded = await request(
      'PUT',
      `/api/edu/live-sessions/${liveSessionId}/grading`,
      {
        teacher_comment: 'This should stay with Ada only.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 79,
        rubric_scores: { claim: 2 },
        inline_annotations: [],
      },
      { Cookie: login.cookie },
    )
    expect(graded.status).toBe(200)

    const retargeted = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        assigned_students: ['Grace Hopper'],
        prompt: 'Now Grace should be the only student on this draft.',
      },
      { Cookie: login.cookie },
    )
    expect(retargeted.status).toBe(200)

    const adaView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    const adaConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )

    expect(adaView.status).toBe(404)
    expect(graceView.status).toBe(200)
    expect(graceView.body.assignment).toMatchObject({
      prompt: 'Now Grace should be the only student on this draft.',
      student_feedback: null,
    })
    expect(adaConfig.status).toBe(200)
    expect(adaConfig.body.assignments).toEqual([])
    expect(graceConfig.status).toBe(200)
    expect(graceConfig.body.assignments).toHaveLength(1)
    expect(graceConfig.body.assignments[0]).toMatchObject({
      id: assignment.body.id,
      student_feedback: null,
    })
  })

  it('clears a revoked students access state without accidentally granting stale approval data back to them or their classmates', async () => {
    const joinCode = `CLR${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Revocation Clear ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Revocation Clear Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        prompt: 'Grace is revoked, then the revocation is cleared.',
        student_temporary_access_until: {
          'ada lovelace': '2099-01-09T01:00:00.000Z',
          'grace hopper': '2099-01-09T01:00:00.000Z',
        },
        student_access_revoked: {
          'grace hopper': true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const graceBefore = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(graceBefore.status).toBe(200)
    expect(graceBefore.body.assignment).toMatchObject({
      access_revoked: true,
      temporary_access_until: '2099-01-09T01:00:00.000Z',
    })

    const cleared = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_temporary_access_until: {
          'ada lovelace': '2099-01-09T01:00:00.000Z',
        },
        student_access_revoked: {},
      },
      { Cookie: login.cookie },
    )
    expect(cleared.status).toBe(200)

    const adaAfter = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceAfter = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaAfter.status).toBe(200)
    expect(graceAfter.status).toBe(200)
    expect(adaAfter.body.assignment).toMatchObject({
      access_revoked: false,
      temporary_access_until: '2099-01-09T01:00:00.000Z',
    })
    expect(graceAfter.body.assignment).toMatchObject({
      access_revoked: false,
      temporary_access_until: null,
      student_access_request: null,
    })
  })

  it('retargets a class-wide assignment to one student without clearing another students pending access request record', async () => {
    const joinCode = `PND${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Pending Isolation ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Pending Isolation Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: [],
        prompt: 'Grace will request access before the teacher narrows visibility.',
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const graceRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Grace Hopper',
        note: 'Grace still needs access later.',
      },
    )
    expect(graceRequest.status).toBe(201)

    const narrowed = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        assigned_students: ['Ada Lovelace'],
      },
      { Cookie: login.cookie },
    )
    expect(narrowed.status).toBe(200)

    const teacherRead = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    const graceDetail = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    const graceConfig = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )

    expect(teacherRead.status).toBe(200)
    expect(Object.keys(teacherRead.body.student_access_requests || {})).toEqual(['grace hopper'])
    expect(teacherRead.body.student_access_requests['grace hopper']).toMatchObject({
      student_name: 'Grace Hopper',
      note: 'Grace still needs access later.',
    })
    expect(graceDetail.status).toBe(404)
    expect(graceConfig.status).toBe(200)
    expect(graceConfig.body.assignments).toEqual([])
  })

  it('removes shared materials without disturbing a classmates surviving per-student override state', async () => {
    const joinCode = `MAT${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Material Isolation ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Material Isolation Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        starter_document: '# Shared outline\n\n- Intro\n- Claim',
        reference_documents: [
          {
            id: 'shared-packet',
            title: 'Shared Packet',
            mime_type: 'application/pdf',
            data_url: 'data:application/pdf;base64,JVBERi0xLjQK',
            size_bytes: 512,
          },
        ],
        policy: {
          export_allowed: true,
          show_rubric_to_student: true,
        },
        student_overrides: {
          'ada lovelace': {
            student_name: 'Ada Lovelace',
            temporary_access_until: '2099-01-10T02:00:00.000Z',
            policy: {
              show_rubric_to_student: true,
            },
          },
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const stripped = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        starter_document: '',
        reference_documents: [],
        policy: {
          export_allowed: false,
          show_rubric_to_student: false,
        },
        student_overrides: {
          'ada lovelace': {
            student_name: 'Ada Lovelace',
            temporary_access_until: '2099-01-10T02:00:00.000Z',
            policy: {
              show_rubric_to_student: true,
            },
          },
        },
      },
      { Cookie: login.cookie },
    )
    expect(stripped.status).toBe(200)

    const adaView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    expect(adaView.status).toBe(200)
    expect(graceView.status).toBe(200)
    expect(adaView.body.assignment).toMatchObject({
      starter_document: '',
      reference_documents: [],
      temporary_access_until: '2099-01-10T02:00:00.000Z',
      policy: {
        export_allowed: false,
        show_rubric_to_student: true,
      },
    })
    expect(graceView.body.assignment).toMatchObject({
      starter_document: '',
      reference_documents: [],
      temporary_access_until: null,
      policy: {
        export_allowed: false,
        show_rubric_to_student: false,
      },
    })
  })

  it('deletes one live-reviewed assignment without disturbing a sibling assignments saved feedback or student view', async () => {
    const joinCode = `SIB${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Sibling Delete ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        teacher_name: 'Ms. Keating',
        join_code: joinCode,
      },
      { Cookie: login.cookie },
    )
    expect(classroom.status).toBe(201)

    const doomedAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Doomed Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This draft will be deleted.',
      },
      { Cookie: login.cookie },
    )
    const survivorAssignment = await request(
      'POST',
      '/api/edu/assignments',
      {
        title: `Survivor Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'This draft should survive with feedback intact.',
      },
      { Cookie: login.cookie },
    )
    expect(doomedAssignment.status).toBe(201)
    expect(survivorAssignment.status).toBe(201)

    const doomedSessionId = `live:${randomUUID()}`
    const survivorSessionId = `live:${randomUUID()}`
    expect(
      (
        await request('POST', '/api/edu/live-sessions', {
          id: doomedSessionId,
          assignment_id: doomedAssignment.body.id,
          assignment_title: doomedAssignment.body.title,
          classroom: classroom.body.name,
          student_name: 'Ada Lovelace',
          current_text: 'Doomed text.',
          document_history: [{ t: 100, pos: 0, del: '', ins: 'Doomed text.' }],
          last_activity_at: '2026-04-29T08:00:00.000Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await request('POST', '/api/edu/live-sessions', {
          id: survivorSessionId,
          assignment_id: survivorAssignment.body.id,
          assignment_title: survivorAssignment.body.title,
          classroom: classroom.body.name,
          student_name: 'Ada Lovelace',
          current_text: 'Survivor text.',
          document_history: [{ t: 140, pos: 0, del: '', ins: 'Survivor text.' }],
          last_activity_at: '2026-04-29T08:01:00.000Z',
          schedule_open: true,
          focused: true,
          hid_active: true,
        })
      ).status,
    ).toBe(201)

    const graded = await request(
      'PUT',
      `/api/edu/live-sessions/${survivorSessionId}/grading`,
      {
        teacher_comment: 'Keep this survivor feedback.',
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 88,
        rubric_scores: { structure: 3 },
        inline_annotations: [],
      },
      { Cookie: login.cookie },
    )
    expect(graded.status).toBe(200)

    const deleted = await request(
      'DELETE',
      `/api/edu/assignments/${doomedAssignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    expect(deleted.status).toBe(200)

    const survivorView = await request(
      'GET',
      `/api/edu/student/assignments/${survivorAssignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const doomedView = await request(
      'GET',
      `/api/edu/student/assignments/${doomedAssignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const survivorTeacherRead = await request(
      'GET',
      `/api/edu/assignments/${survivorAssignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )
    const config = await request(
      'GET',
      `/api/edu/student/config?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )

    expect(survivorView.status).toBe(200)
    expect(survivorView.body.assignment.student_feedback).toMatchObject({
      teacher_comment: 'Keep this survivor feedback.',
      grade_label: 'Revise',
      grade_score: '88',
    })
    expect(doomedView.status).toBe(404)
    expect(survivorTeacherRead.status).toBe(200)
    expect(config.status).toBe(200)
    expect(config.body.assignments).toHaveLength(1)
    expect(config.body.assignments[0]).toMatchObject({
      id: survivorAssignment.body.id,
      student_feedback: expect.objectContaining({
        teacher_comment: 'Keep this survivor feedback.',
      }),
    })
  })

  it('reopens one student with a new extension without reviving a classmates old revocation or pending request state', async () => {
    const joinCode = `RPN${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: `Reopen Isolation ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
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
        title: `Reopen Isolation Draft ${randomUUID().replace(/-/g, '').slice(0, 5)}`,
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        course: classroom.body.name,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
        prompt: 'Ada should reopen cleanly without reviving Grace state.',
        student_access_revoked: {
          'grace hopper': true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const graceRequest = await request(
      'POST',
      `/api/edu/assignments/${assignment.body.id}/access-requests`,
      {
        student_name: 'Grace Hopper',
        note: 'Grace is still waiting on approval.',
      },
    )
    expect(graceRequest.status).toBe(201)

    const reopenedUntil = '2099-01-11T03:30:00.000Z'
    const reopened = await request(
      'PUT',
      `/api/edu/assignments/${assignment.body.id}`,
      {
        student_temporary_access_until: {
          'ada lovelace': reopenedUntil,
        },
        student_access_requests: {
          'grace hopper': {
            student_name: 'Grace Hopper',
            requested_at: graceRequest.body.student_access_request.requested_at,
            note: 'Grace is still waiting on approval.',
          },
        },
        student_access_revoked: {
          'grace hopper': true,
        },
      },
      { Cookie: login.cookie },
    )
    expect(reopened.status).toBe(200)

    const adaView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    const graceView = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Grace Hopper')}`,
    )
    const teacherRead = await request(
      'GET',
      `/api/edu/assignments/${assignment.body.id}`,
      undefined,
      { Cookie: login.cookie },
    )

    expect(adaView.status).toBe(200)
    expect(adaView.body.assignment).toMatchObject({
      access_revoked: false,
      temporary_access_until: reopenedUntil,
      student_access_request: null,
    })
    expect(graceView.status).toBe(200)
    expect(graceView.body.assignment).toMatchObject({
      access_revoked: true,
      temporary_access_until: null,
      student_access_request: expect.objectContaining({
        student_name: 'Grace Hopper',
        note: 'Grace is still waiting on approval.',
      }),
    })
    expect(teacherRead.status).toBe(200)
    expect(teacherRead.body.student_temporary_access_until).toMatchObject({
      'ada lovelace': reopenedUntil,
    })
    expect(teacherRead.body.student_access_revoked).toMatchObject({
      'grace hopper': true,
    })
  })

  it('lets a teacher add inline comments to a live student draft and exposes them immediately to the student view', async () => {
    const joinCode = `LIVE${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const login = await teacherLogin()
    expect(login.status).toBe(200)

    const classroom = await request(
      'POST',
      '/api/edu/classrooms',
      {
        name: 'Live Comment English',
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
        title: 'Live comments',
        course: 'English',
        classroom_id: classroom.body.id,
        classroom_name: classroom.body.name,
        assigned_students: ['Ada Lovelace'],
        prompt: 'Draft while the teacher leaves inline comments.',
        policy: {
          allow_offline_editing: false,
        },
      },
      { Cookie: login.cookie },
    )
    expect(assignment.status).toBe(201)

    const liveSessionId = `live-comment:${randomUUID()}`
    const liveDraft = 'Live text should keep streaming while comments arrive.'
    const publish = await request('POST', '/api/edu/live-sessions', {
      id: liveSessionId,
      assignment_id: assignment.body.id,
      assignment_title: assignment.body.title,
      course: assignment.body.course,
      classroom: classroom.body.name,
      student_name: 'Ada Lovelace',
      current_text: liveDraft,
      document_history: [{ t: 100, pos: 0, del: '', ins: liveDraft }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: new Date().toISOString(),
      schedule_open: true,
      focused: true,
      hid_active: true,
    })
    expect(publish.status).toBe(201)

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`,
      {
        teacher_comment: 'Keep going, but tighten the opening.',
        inline_annotations: [
          {
            type: 'comment',
            start: 0,
            end: 9,
            quote: 'Live text',
            note: 'Start with the claim a little sooner.',
          },
        ],
      },
      { Cookie: login.cookie },
    )
    expect(grading.status).toBe(200)
    expect(grading.body.grading.inline_annotations).toEqual([
      expect.objectContaining({
        type: 'comment',
        quote: 'Live text',
        note: 'Start with the claim a little sooner.',
      }),
    ])

    const studentAssignment = await request(
      'GET',
      `/api/edu/student/assignments/${assignment.body.id}?join_code=${joinCode}&student_name=${encodeURIComponent('Ada Lovelace')}`,
    )
    expect(studentAssignment.status).toBe(200)
    expect(studentAssignment.body.assignment.student_feedback).toMatchObject({
      teacher_comment: 'Keep going, but tighten the opening.',
      inline_annotations: [
        expect.objectContaining({
          type: 'comment',
          quote: 'Live text',
          note: 'Start with the claim a little sooner.',
        }),
      ],
    })
  })
})
