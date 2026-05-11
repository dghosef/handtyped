import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createApp } from './server-lib.js'
import { applyLiveReplayUpdates } from './public/edu/app-ui.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

async function teacherSignup(label = 'demo') {
  const email = `${label}-${randomUUID()}@edu.handtyped.app`
  const signup = await request('POST', '/api/edu/auth/signup', {
    name: 'Demo Teacher',
    email,
    password: 'demo-password',
  })
  expect(signup.status).toBe(201)
  return {
    session: signup.body,
    cookie: signup.headers.get('set-cookie') || '',
  }
}

async function createClassroom(cookie, overrides = {}) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()
  const classroom = await request(
    'POST',
    '/api/edu/classrooms',
    {
      name: overrides.name || `Demo Class ${suffix}`,
      teacher_name: 'Ms. Demo',
      join_code: overrides.join_code || `DM${suffix.slice(0, 5)}`,
    },
    { Cookie: cookie },
  )
  expect(classroom.status).toBe(201)
  return classroom.body
}

async function createAssignment(cookie, classroom, overrides = {}) {
  const assignment = await request(
    'POST',
    '/api/edu/assignments',
    {
      title: overrides.title || 'Demo Draft',
      course: overrides.course || classroom.name,
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      prompt: overrides.prompt || 'Write a claim and support it with evidence.',
      assigned_students: overrides.assigned_students,
      policy: overrides.policy || {
        allow_offline_editing: true,
        copy_paste_allowed: false,
        require_lockdown: true,
      },
      browser_policy: overrides.browser_policy || {
        browser_enabled: true,
        home_url: 'https://example.edu/source',
        allowed_domains: ['example.edu'],
        log_all_navigation: true,
      },
    },
    { Cookie: cookie },
  )
  expect(assignment.status).toBe(201)
  return assignment.body
}

async function updateAssignment(cookie, assignmentId, patch) {
  const updated = await request('PUT', `/api/edu/assignments/${assignmentId}`, patch, { Cookie: cookie })
  expect(updated.status).toBe(200)
  return updated.body
}

async function studentConfig(joinCode, studentName) {
  return request(
    'GET',
    `/api/edu/student/config?join_code=${encodeURIComponent(joinCode)}&student_name=${encodeURIComponent(studentName)}`,
  )
}

function sessionIdFor(assignmentId, studentName) {
  return `demo-survival:${assignmentId}:${studentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

async function publishDraft({
  assignment,
  classroom,
  studentName = 'Ada Lovelace',
  text,
  history,
  minute = 0,
  url = null,
  urlTitle = null,
  urlHistory = [],
  focused = true,
  scheduleOpen = true,
}) {
  return request('POST', '/api/edu/live-sessions', {
    id: sessionIdFor(assignment.id, studentName),
    assignment_id: assignment.id,
    assignment_title: assignment.title,
    course: assignment.course,
    classroom: classroom.name,
    student_name: studentName,
    current_text: text,
    document_history: history,
    current_url: url,
    current_url_title: urlTitle,
    url_history: urlHistory,
    violation_count: 0,
    violations: [],
    last_activity_at: `2026-05-07T14:${String(minute).padStart(2, '0')}:00.000Z`,
    schedule_open: scheduleOpen,
    focused,
    hid_active: true,
  })
}

function assignmentById(config, assignmentId) {
  return (config.body?.assignments || []).find((assignment) => assignment.id === assignmentId) || null
}

beforeAll(async () => {
  sessionsDir = join(__dirname, `edu-demo-survival-${randomUUID()}`)
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

describe('demo survival contracts', () => {
  it('reconstructs missed large draft updates from history tails without resending the full text', async () => {
    const teacher = await teacherSignup('large-replay')
    const classroom = await createClassroom(teacher.cookie)
    const assignment = await createAssignment(teacher.cookie, classroom)
    const initialText = `Opening claim.\n\n${'x'.repeat(60_000)}`
    const initialHistory = [{ t: 100, pos: 0, del: '', ins: initialText }]

    const firstPublish = await publishDraft({
      assignment,
      classroom,
      text: initialText,
      history: initialHistory,
      minute: 1,
    })
    expect(firstPublish.status).toBe(201)

    const fullReplay = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(sessionIdFor(assignment.id, 'Ada Lovelace'))}`,
      undefined,
      { Cookie: teacher.cookie },
    )
    expect(fullReplay.status).toBe(200)
    expect(fullReplay.body.current_text).toBe(initialText)

    const tail = { t: 900, pos: initialText.length, del: '', ins: '\n\nThe student adds one final note.' }
    const finalText = `${initialText}${tail.ins}`
    const secondPublish = await publishDraft({
      assignment,
      classroom,
      text: finalText,
      history: [...initialHistory, tail],
      minute: 2,
    })
    expect(secondPublish.status).toBe(201)

    const updates = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(sessionIdFor(assignment.id, 'Ada Lovelace'))}/updates?since_seq=1`,
      undefined,
      { Cookie: teacher.cookie },
    )
    expect(updates.status).toBe(200)
    expect(updates.body.current_text).toBeUndefined()
    expect(updates.body.current_text_length).toBe(finalText.length)
    expect(updates.body.events).toHaveLength(1)
    expect(updates.body.events[0]).toMatchObject({
      seq: 2,
      current_text_length: finalText.length,
      document_history_tail: [tail],
    })
    expect(updates.body.events[0].current_text).toBeUndefined()

    const merged = applyLiveReplayUpdates(fullReplay.body, updates.body)
    expect(merged.current_text).toBe(finalText)
    expect(merged.last_seq).toBe(2)
  })

  it('keeps missed review polls, assignment edits, browser policy, and the latest live draft aligned', async () => {
    const teacher = await teacherSignup('missed-polls')
    const classroom = await createClassroom(teacher.cookie)
    let assignment = await createAssignment(teacher.cookie, classroom, {
      assigned_students: ['Ada Lovelace'],
    })

    const firstDraft = 'Ada opens with a claim.'
    const firstHistory = [{ t: 100, pos: 0, del: '', ins: firstDraft }]
    const firstPublish = await publishDraft({
      assignment,
      classroom,
      text: firstDraft,
      history: firstHistory,
      minute: 3,
    })
    expect(firstPublish.status).toBe(201)

    const initialReplay = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(sessionIdFor(assignment.id, 'Ada Lovelace'))}`,
      undefined,
      { Cookie: teacher.cookie },
    )
    expect(initialReplay.status).toBe(200)
    expect(initialReplay.body.last_seq).toBe(1)

    assignment = await updateAssignment(teacher.cookie, assignment.id, {
      title: 'Demo Draft Revised',
      prompt: 'Use the source and add one concrete example.',
      browser_policy: {
        browser_enabled: true,
        home_url: 'https://example.edu/revised-source',
        allowed_domains: ['example.edu', 'library.example.edu'],
        log_all_navigation: true,
      },
    })

    const secondTail = { t: 540, pos: firstDraft.length, del: '', ins: '\n\nA second paragraph cites the source.' }
    const secondDraft = `${firstDraft}${secondTail.ins}`
    const thirdTail = { t: 880, pos: secondDraft.length, del: '', ins: '\n\nThe ending ties the example back to the claim.' }
    const thirdDraft = `${secondDraft}${thirdTail.ins}`

    expect(
      (await publishDraft({
        assignment,
        classroom,
        text: secondDraft,
        history: [...firstHistory, secondTail],
        minute: 4,
        url: 'https://example.edu/revised-source',
        urlTitle: 'Revised Source',
        urlHistory: [{ t: 560, url: 'https://example.edu/revised-source', allowed: true, source: 'embedded_navigation' }],
      })).status,
    ).toBe(201)
    expect(
      (await publishDraft({
        assignment,
        classroom,
        text: thirdDraft,
        history: [...firstHistory, secondTail, thirdTail],
        minute: 5,
        url: 'https://library.example.edu/archive',
        urlTitle: 'Library Archive',
        urlHistory: [
          { t: 560, url: 'https://example.edu/revised-source', allowed: true, source: 'embedded_navigation' },
          { t: 900, url: 'https://library.example.edu/archive', allowed: true, source: 'student_navigation' },
        ],
      })).status,
    ).toBe(201)

    const missedUpdates = await request(
      'GET',
      `/api/edu/live-replays/${encodeURIComponent(sessionIdFor(assignment.id, 'Ada Lovelace'))}/updates?since_seq=${initialReplay.body.last_seq}`,
      undefined,
      { Cookie: teacher.cookie },
    )
    expect(missedUpdates.status).toBe(200)
    expect(missedUpdates.body).toMatchObject({
      current_text: thirdDraft,
      current_url: 'https://library.example.edu/archive',
      current_url_title: 'Library Archive',
      last_seq: 3,
    })
    expect(missedUpdates.body.events.map((event) => event.seq)).toEqual([2, 3])
    expect(missedUpdates.body.events.at(-1)).toMatchObject({
      current_text: thirdDraft,
      document_history_tail: [thirdTail],
    })

    const adaConfig = await studentConfig(classroom.join_code, 'Ada Lovelace')
    expect(adaConfig.status).toBe(200)
    expect(assignmentById(adaConfig, assignment.id)).toMatchObject({
      title: 'Demo Draft Revised',
      prompt: 'Use the source and add one concrete example.',
      browser_policy: expect.objectContaining({
        home_url: 'https://example.edu/revised-source',
        allowed_domains: ['example.edu', 'library.example.edu'],
      }),
    })

    const merged = applyLiveReplayUpdates(initialReplay.body, missedUpdates.body)
    expect(merged.current_text).toBe(thirdDraft)
    expect(merged.url_history.at(-1)).toMatchObject({ url: 'https://library.example.edu/archive' })
  })

  it('rejects a rapid duplicate classroom create without leaving duplicate or blank demo classes', async () => {
    const teacher = await teacherSignup('duplicate-class')
    const suffix = randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()
    const name = `No Duplicate Demo ${suffix}`
    const joinCode = `ND${suffix.slice(0, 5)}`

    const first = await request(
      'POST',
      '/api/edu/classrooms',
      { name, teacher_name: 'Ms. Demo', join_code: joinCode },
      { Cookie: teacher.cookie },
    )
    const second = await request(
      'POST',
      '/api/edu/classrooms',
      { name, teacher_name: 'Ms. Demo', join_code: joinCode },
      { Cookie: teacher.cookie },
    )
    expect(first.status).toBe(201)
    expect(second.status).toBe(409)

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, { Cookie: teacher.cookie })
    expect(dashboard.status).toBe(200)
    const matchingClasses = dashboard.body.classrooms.filter((classroom) => classroom.name === name)
    expect(matchingClasses).toHaveLength(1)
    expect(dashboard.body.classrooms.some((classroom) => String(classroom.name || '').trim() === '')).toBe(false)
  })

  it('preserves teacher review history and published feedback when live assignment visibility narrows', async () => {
    const teacher = await teacherSignup('visibility-feedback')
    const classroom = await createClassroom(teacher.cookie)
    const assignment = await createAssignment(teacher.cookie, classroom, {
      assigned_students: [],
    })

    const adaDraft = 'Ada writes the visible demo draft.'
    const graceDraft = 'Grace writes before visibility changes.'
    expect(
      (await publishDraft({
        assignment,
        classroom,
        studentName: 'Ada Lovelace',
        text: adaDraft,
        history: [{ t: 100, pos: 0, del: '', ins: adaDraft }],
        minute: 6,
      })).status,
    ).toBe(201)
    expect(
      (await publishDraft({
        assignment,
        classroom,
        studentName: 'Grace Hopper',
        text: graceDraft,
        history: [{ t: 100, pos: 0, del: '', ins: graceDraft }],
        minute: 7,
      })).status,
    ).toBe(201)

    const grading = await request(
      'PUT',
      `/api/edu/live-sessions/${encodeURIComponent(sessionIdFor(assignment.id, 'Grace Hopper'))}/grading`,
      {
        teacher_comment: 'This evidence is useful; keep it for revision.',
        inline_annotations: [{ id: 'grace-note', type: 'comment', quote: 'evidence', note: 'Anchor this.' }],
        publish_feedback: true,
      },
      { Cookie: teacher.cookie },
    )
    expect(grading.status).toBe(200)

    const narrowed = await updateAssignment(teacher.cookie, assignment.id, {
      assigned_students: ['Ada Lovelace'],
    })
    expect(narrowed.assigned_students).toEqual(['Ada Lovelace'])

    const adaConfig = await studentConfig(classroom.join_code, 'Ada Lovelace')
    const graceConfig = await studentConfig(classroom.join_code, 'Grace Hopper')
    expect(Boolean(assignmentById(adaConfig, assignment.id))).toBe(true)
    expect(Boolean(assignmentById(graceConfig, assignment.id))).toBe(false)

    const dashboard = await request('GET', '/api/edu/dashboard', undefined, { Cookie: teacher.cookie })
    expect(dashboard.status).toBe(200)
    const liveSessions = dashboard.body.live_sessions.filter((session) => session.assignment_id === assignment.id)
    expect(liveSessions.map((session) => session.student_name).sort()).toEqual(['Ada Lovelace', 'Grace Hopper'])

    const graceReview = await request(
      'GET',
      `/api/edu/live-sessions/${encodeURIComponent(sessionIdFor(assignment.id, 'Grace Hopper'))}`,
      undefined,
      { Cookie: teacher.cookie },
    )
    expect(graceReview.status).toBe(200)
    expect(graceReview.body).toMatchObject({
      current_text: graceDraft,
      grading: expect.objectContaining({
        teacher_comment: 'This evidence is useful; keep it for revision.',
        feedback_status: 'published',
      }),
    })
  })
})
