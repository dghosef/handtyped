import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

async function teacherLogin() {
  const res = await fetch(`${baseUrl}/api/edu/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'password',
      email: 'teacher@edu.handtyped.app',
      password: 'handtyped-edu',
    }),
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
})
