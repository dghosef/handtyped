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
const JOIN_CODE_SUFFIX = randomUUID().replace(/-/g, '').slice(0, 3).toUpperCase()

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

function joinCode(prefix, index) {
  return `${prefix}${String(index + 1).padStart(2, '0')}${JOIN_CODE_SUFFIX}`
}

function ts(minute) {
  return `2026-04-28T17:${String(minute).padStart(2, '0')}:00.000Z`
}

async function createClassroom(login, name, code) {
  const response = await request(
    'POST',
    '/api/edu/classrooms',
    {
      name,
      teacher_name: 'Ms. Keating',
      join_code: code,
    },
    { Cookie: login.cookie },
  )
  expect(response.status).toBe(201)
  return response.body
}

async function createAssignment(login, classroom, overrides = {}) {
  const response = await request(
    'POST',
    '/api/edu/assignments',
    {
      title: overrides.title || 'Feature workflow draft',
      course: overrides.course || classroom.name,
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      prompt: overrides.prompt || 'Write a classroom draft.',
      instructions: overrides.instructions,
      assigned_students: overrides.assigned_students,
      policy: overrides.policy,
      editor_policy: overrides.editor_policy,
      browser_policy: overrides.browser_policy,
      linked_assignment_ids: overrides.linked_assignment_ids,
      temporary_access_until: overrides.temporary_access_until,
      student_temporary_access_until: overrides.student_temporary_access_until,
      student_access_revoked: overrides.student_access_revoked,
      student_overrides: overrides.student_overrides,
    },
    { Cookie: login.cookie },
  )
  expect(response.status).toBe(201)
  return response.body
}

async function studentConfig(code, studentName) {
  return request(
    'GET',
    `/api/edu/student/config?join_code=${code}&student_name=${encodeURIComponent(studentName)}`,
  )
}

async function studentAssignment(assignmentId, code, studentName) {
  return request(
    'GET',
    `/api/edu/student/assignments/${assignmentId}?join_code=${code}&student_name=${encodeURIComponent(studentName)}`,
  )
}

async function publishLiveSession({
  liveSessionId,
  assignment,
  classroom,
  studentName = 'Ada Lovelace',
  currentText,
  documentHistory,
  urlHistory = [],
  currentUrl = null,
  currentUrlTitle = null,
  minute,
  focused = true,
  hidActive = true,
  replaySessionId = null,
  extra = {},
}) {
  return request('POST', '/api/edu/live-sessions', {
    id: liveSessionId,
    assignment_id: assignment.id,
    assignment_title: assignment.title,
    course: assignment.course,
    classroom: classroom.name,
    student_name: studentName,
    current_text: currentText,
    document_history: documentHistory,
    current_url: currentUrl,
    current_url_title: currentUrlTitle,
    url_history: urlHistory,
    violation_count: 0,
    violations: [],
    last_activity_at: ts(minute),
    schedule_open: true,
    focused,
    hid_active: hidActive,
    replay_session_id: replaySessionId,
    ...extra,
  })
}

async function publishReplay(replay) {
  return request('POST', '/api/edu/replays', replay)
}

function assignmentById(config, assignmentId) {
  return (config.body.assignments || []).find((item) => item.id === assignmentId) || null
}

beforeAll(async () => {
  sessionsDir = join(__dirname, `edu-feature-workflow-matrix-${randomUUID()}`)
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

describe('feature workflow matrix almost end-to-end', () => {
  const linkedCases = Array.from({ length: 6 }, (_, index) => ({
    currentTargets: index % 2 === 0 ? ['Ada Lovelace'] : [],
    finalTargets: index % 3 === 0 ? ['Grace Hopper'] : ['Ada Lovelace', 'Grace Hopper'],
    includeThirdDraft: index % 2 === 1,
    deletePrior: index % 3 === 1,
  }))

  for (const [index, scenario] of linkedCases.entries()) {
    it(`linked workflow ${index + 1} keeps student-facing linked references and visibility aligned`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('LNK', index)
      const classroom = await createClassroom(login, `Linked workflow ${index + 1}`, code)
      const prior = await createAssignment(login, classroom, {
        title: `Notebook draft ${index + 1}`,
        prompt: `First notebook prompt ${index + 1}`,
      })
      const bridge = scenario.includeThirdDraft
        ? await createAssignment(login, classroom, {
            title: `Bridge draft ${index + 1}`,
            prompt: `Bridge prompt ${index + 1}`,
          })
        : null
      const linkedIds = [prior.id, bridge?.id].filter(Boolean)
      const current = await createAssignment(login, classroom, {
        title: `Revision draft ${index + 1}`,
        prompt: `Revision prompt ${index + 1}`,
        assigned_students: scenario.currentTargets,
        linked_assignment_ids: linkedIds,
      })

      const firstVisibleStudent = scenario.currentTargets.length ? 'Ada Lovelace' : 'Grace Hopper'
      const firstConfig = await studentConfig(code, firstVisibleStudent)
      expect(firstConfig.status).toBe(200)
      expect(assignmentById(firstConfig, current.id)).toMatchObject({
        id: current.id,
        linked_assignment_ids: linkedIds,
      })

      const firstAssignment = await studentAssignment(current.id, code, firstVisibleStudent)
      expect(firstAssignment.status).toBe(200)
      expect(firstAssignment.body.assignment).toMatchObject({
        id: current.id,
        linked_assignment_ids: linkedIds,
      })

      const hiddenStudent = scenario.currentTargets.length ? 'Grace Hopper' : 'Ada Lovelace'
      const hiddenAssignment = await studentAssignment(current.id, code, hiddenStudent)
      if (scenario.currentTargets.length) {
        expect(hiddenAssignment.status).toBe(404)
        expect(hiddenAssignment.body).toMatchObject({ error: 'Not found' })
      } else {
        expect(hiddenAssignment.status).toBe(200)
        expect(hiddenAssignment.body.assignment).toMatchObject({ id: current.id })
      }

      const updatedLinkedIds = scenario.includeThirdDraft ? [bridge.id] : [prior.id]
      const update = await request(
        'PUT',
        `/api/edu/assignments/${current.id}`,
        {
          linked_assignment_ids: updatedLinkedIds,
          assigned_students: scenario.finalTargets,
          prompt: `Updated revision prompt ${index + 1}`,
        },
        { Cookie: login.cookie },
      )
      expect(update.status).toBe(200)

      if (scenario.deletePrior) {
        const deleted = await request(
          'DELETE',
          `/api/edu/assignments/${prior.id}`,
          undefined,
          { Cookie: login.cookie },
        )
        expect(deleted.status).toBe(200)
      }

      const finalAda = await studentAssignment(current.id, code, 'Ada Lovelace')
      const finalGrace = await studentAssignment(current.id, code, 'Grace Hopper')
      const adaVisible = scenario.finalTargets.length === 0 || scenario.finalTargets.includes('Ada Lovelace')
      const graceVisible =
        scenario.finalTargets.length === 0 || scenario.finalTargets.includes('Grace Hopper')
      expect(finalAda.status).toBe(adaVisible ? 200 : 404)
      expect(finalGrace.status).toBe(graceVisible ? 200 : 404)
      if (adaVisible) {
        expect(finalAda.body.assignment).toMatchObject({
          id: current.id,
          prompt: `Updated revision prompt ${index + 1}`,
          linked_assignment_ids: updatedLinkedIds,
        })
      }
      if (graceVisible) {
        expect(finalGrace.body.assignment).toMatchObject({
          id: current.id,
          linked_assignment_ids: updatedLinkedIds,
        })
      }
    })
  }

  const liveReplayCases = Array.from({ length: 6 }, (_, index) => ({
    attachReplayAfterFirstPublish: index % 2 === 0,
    closeWithBlankText: index % 3 === 0,
    thirdPublishChangesUrlOnly: index % 2 === 1,
  }))

  for (const [index, scenario] of liveReplayCases.entries()) {
    it(`live replay workflow ${index + 1} keeps teacher incremental updates aligned with student publishes`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('LRP', index)
      const classroom = await createClassroom(login, `Live replay ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Live replay draft ${index + 1}`,
        assigned_students: ['Ada Lovelace'],
      })

      const liveSessionId = `live-replay:${index}:${randomUUID()}`
      const replayId = `replay:${index}:${randomUUID()}`
      const firstText = `Claim ${index + 1}`
      const secondText = `${firstText}\n\nEvidence ${index + 1}`
      const thirdText = scenario.closeWithBlankText ? '' : `${secondText}\n\nConclusion ${index + 1}`

      const firstPublish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText: firstText,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: firstText }],
        minute: index,
      })
      expect(firstPublish.status).toBe(201)

      if (scenario.attachReplayAfterFirstPublish) {
        const replayPublish = await publishReplay({
          id: replayId,
          live_session_id: liveSessionId,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          course: assignment.course,
          classroom: classroom.name,
          student_name: 'Ada Lovelace',
          current_text: firstText,
          document_history: [{ t: 100, text: firstText }],
          replay_origin_wall_ms: 1_700_000_000_000 + index,
          recorded_timezone_offset_minutes: -240,
          recorded_timezone: 'America/New_York',
          start_wall_ns: 123_456 + index,
        })
        expect(replayPublish.status).toBe(201)
      }

      const secondPublish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText: secondText,
        documentHistory: [
          { t: 100, pos: 0, del: '', ins: firstText },
          { t: 220, pos: firstText.length, del: '', ins: `\n\nEvidence ${index + 1}` },
        ],
        urlHistory: [
          {
            t: 300,
            url: `https://example.org/evidence-${index + 1}`,
            allowed: true,
            source: 'embedded_navigation',
          },
        ],
        currentUrl: `https://example.org/evidence-${index + 1}`,
        currentUrlTitle: `Evidence ${index + 1}`,
        minute: index + 1,
        replaySessionId: scenario.attachReplayAfterFirstPublish ? replayId : null,
      })
      expect(secondPublish.status).toBe(201)

      const secondUpdate = await request(
        'GET',
        `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates?since_seq=1`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(secondUpdate.status).toBe(200)
      expect(secondUpdate.body.events).toHaveLength(1)
      expect(secondUpdate.body.events[0]).toMatchObject({
        seq: 2,
        current_text: secondText,
        document_history_tail: [{ t: 220, pos: firstText.length, del: '', ins: `\n\nEvidence ${index + 1}` }],
      })
      expect(secondUpdate.body.current_url).toBe(`https://example.org/evidence-${index + 1}`)
      if (scenario.attachReplayAfterFirstPublish) {
        expect(secondUpdate.body.replay_session_id).toBe(replayId)
      }

      const thirdPublish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText: thirdText,
        documentHistory: scenario.thirdPublishChangesUrlOnly
          ? [
              { t: 100, pos: 0, del: '', ins: firstText },
              { t: 220, pos: firstText.length, del: '', ins: `\n\nEvidence ${index + 1}` },
            ]
          : [
              { t: 100, pos: 0, del: '', ins: firstText },
              { t: 220, pos: firstText.length, del: '', ins: `\n\nEvidence ${index + 1}` },
              { t: 340, pos: secondText.length, del: '', ins: `\n\nConclusion ${index + 1}` },
            ],
        urlHistory: [
          {
            t: 300,
            url: `https://example.org/evidence-${index + 1}`,
            allowed: true,
            source: 'embedded_navigation',
          },
          {
            t: 420,
            url: `https://example.org/conclusion-${index + 1}`,
            allowed: true,
            source: 'embedded_navigation',
          },
        ],
        currentUrl: `https://example.org/conclusion-${index + 1}`,
        currentUrlTitle: `Conclusion ${index + 1}`,
        minute: index + 2,
        replaySessionId: scenario.attachReplayAfterFirstPublish ? replayId : null,
      })
      expect(thirdPublish.status).toBe(201)

      const teacherReplay = await request(
        'GET',
        `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherReplay.status).toBe(200)
      expect(teacherReplay.body.current_text).toBe(scenario.closeWithBlankText ? secondText : thirdText)
      expect(teacherReplay.body.last_seq).toBe(3)

      const thirdUpdate = await request(
        'GET',
        `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates?since_seq=2`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(thirdUpdate.status).toBe(200)
      expect(thirdUpdate.body.events).toHaveLength(1)
      expect(thirdUpdate.body.events[0].seq).toBe(3)
      expect(thirdUpdate.body.events[0].current_url).toBe(`https://example.org/conclusion-${index + 1}`)

      const noOpPoll = await request(
        'GET',
        `/api/edu/live-replays/${encodeURIComponent(liveSessionId)}/updates?since_seq=3`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(noOpPoll.status).toBe(200)
      expect(noOpPoll.body.events).toEqual([])
    })
  }

  it('live replay tail checkpoint workflow reconstructs server current text without full draft uploads', async () => {
    const login = await teacherLogin()
    expect(login.status).toBe(200)
    const code = joinCode('TAIL', 0)
    const classroom = await createClassroom(login, 'Tail sync', code)
    const assignment = await createAssignment(login, classroom, {
      title: 'Tail sync draft',
      assigned_students: ['Ada Lovelace'],
    })
    const liveSessionId = `tail-sync:${randomUUID()}`
    const firstText = 'Hello'
    const secondText = 'Hello world'

    const checkpoint = await publishLiveSession({
      liveSessionId,
      assignment,
      classroom,
      currentText: '',
      documentHistory: [],
      minute: 1,
      extra: {
        current_text: undefined,
        document_history: undefined,
        current_text_checkpoint: firstText,
        history_base_count: 0,
        history_base_t: 0,
        document_history_tail: [{ t: 100, pos: 0, del: '', ins: firstText }],
      },
    })
    expect(checkpoint.status).toBe(201)
    expect(checkpoint.body.current_text).toBe(firstText)
    expect(checkpoint.body.accepted_history_count).toBe(1)
    expect(checkpoint.body.latest_history_t).toBe(100)
    expect(checkpoint.body.used_checkpoint).toBe(true)

    const tail = await publishLiveSession({
      liveSessionId,
      assignment,
      classroom,
      currentText: '',
      documentHistory: [],
      minute: 2,
      extra: {
        current_text: undefined,
        document_history: undefined,
        history_base_count: 1,
        history_base_t: 100,
        document_history_tail: [{ t: 220, pos: firstText.length, del: '', ins: ' world' }],
      },
    })
    expect(tail.status).toBe(201)
    expect(tail.body.current_text).toBe(secondText)
    expect(tail.body.document_history).toHaveLength(2)
    expect(tail.body.accepted_history_count).toBe(2)
    expect(tail.body.latest_history_t).toBe(220)

    const stale = await publishLiveSession({
      liveSessionId,
      assignment,
      classroom,
      currentText: '',
      documentHistory: [],
      minute: 3,
      extra: {
        current_text: undefined,
        document_history: undefined,
        history_base_count: 0,
        history_base_t: 0,
        document_history_tail: [{ t: 340, pos: secondText.length, del: '', ins: '!' }],
      },
    })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({
      error: 'checkpoint_required',
      accepted_history_count: 2,
      latest_history_t: 220,
      needs_checkpoint: true,
    })
  })

  const browserPolicyCases = Array.from({ length: 6 }, (_, index) => ({
    browserEnabled: index % 2 === 0,
    overrideEnabled: index % 3 === 0,
    fontSize: [16, 18, 20, 22, 24, 28][index],
  }))

  for (const [index, scenario] of browserPolicyCases.entries()) {
    it(`browser workflow ${index + 1} refreshes browser policy, overrides, and student assignment detail reads`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('BRW', index)
      const classroom = await createClassroom(login, `Browser workflow ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Browser draft ${index + 1}`,
        assigned_students: [],
        browser_policy: {
          browser_enabled: true,
          home_url: `https://example.org/start-${index + 1}`,
          allowed_domains: ['example.org'],
          log_all_navigation: true,
        },
      })

      const update = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          browser_policy: {
            browser_enabled: scenario.browserEnabled,
            home_url: `https://library.example.org/home-${index + 1}`,
            allowed_domains: ['library.example.org', `source${index + 1}.example.org`],
            log_all_navigation: true,
          },
          student_overrides: {
            'ada lovelace': {
              student_name: 'Ada Lovelace',
              browser_policy: {
                browser_enabled: scenario.overrideEnabled,
                home_url: `https://ada.example.org/home-${index + 1}`,
                allowed_domains: [`ada${index + 1}.example.org`],
              },
              editor_policy: {
                font_size: scenario.fontSize,
              },
            },
          },
        },
        { Cookie: login.cookie },
      )
      expect(update.status).toBe(200)

      const adaConfig = await studentConfig(code, 'Ada Lovelace')
      const graceConfig = await studentConfig(code, 'Grace Hopper')
      expect(adaConfig.status).toBe(200)
      expect(graceConfig.status).toBe(200)
      expect(assignmentById(adaConfig, assignment.id)).toMatchObject({
        browser_policy: {
          browser_enabled: scenario.overrideEnabled,
          home_url: `https://ada.example.org/home-${index + 1}`,
          allowed_domains: [`ada${index + 1}.example.org`],
        },
        editor_policy: {
          font_size: scenario.fontSize,
        },
      })
      expect(assignmentById(graceConfig, assignment.id)).toMatchObject({
        browser_policy: {
          browser_enabled: scenario.browserEnabled,
          home_url: `https://library.example.org/home-${index + 1}`,
          allowed_domains: ['library.example.org', `source${index + 1}.example.org`],
        },
      })

      const adaAssignment = await studentAssignment(assignment.id, code, 'Ada Lovelace')
      const graceAssignment = await studentAssignment(assignment.id, code, 'Grace Hopper')
      expect(adaAssignment.status).toBe(200)
      expect(graceAssignment.status).toBe(200)
      expect(adaAssignment.body.assignment).toMatchObject({
        browser_policy: {
          browser_enabled: scenario.overrideEnabled,
          home_url: `https://ada.example.org/home-${index + 1}`,
        },
      })
      expect(graceAssignment.body.assignment).toMatchObject({
        browser_policy: {
          browser_enabled: scenario.browserEnabled,
          home_url: `https://library.example.org/home-${index + 1}`,
        },
      })

      const audit = await request('GET', `/api/edu/assignments/${assignment.id}/audit`, undefined, {
        Cookie: login.cookie,
      })
      expect(audit.status).toBe(200)
      expect(audit.body[0].changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Student setting overrides' }),
          expect.objectContaining({ label: 'Browser policy' }),
        ]),
      )
    })
  }

  const accessCases = Array.from({ length: 6 }, (_, index) => ({
    assignedStudents: index % 2 === 0 ? ['Ada Lovelace'] : [],
    extensionMinute: `2026-04-28T2${index}:45:00.000Z`,
    revokeAfterApprove: index % 3 === 0,
  }))

  for (const [index, scenario] of accessCases.entries()) {
    it(`access workflow ${index + 1} carries student requests through approval, refresh, and optional revocation`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('ACS', index)
      const classroom = await createClassroom(login, `Access lifecycle ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Access lifecycle draft ${index + 1}`,
        assigned_students: scenario.assignedStudents,
        temporary_access_until: `2026-04-28T1${index}:00:00.000Z`,
      })

      const requestAccess = await request(
        'POST',
        `/api/edu/assignments/${assignment.id}/access-requests`,
        {
          student_name: 'Ada Lovelace',
          note: `Need help finishing paragraph ${index + 1}`,
        },
      )
      expect(requestAccess.status).toBe(201)

      const configWithRequest = await studentConfig(code, 'Ada Lovelace')
      expect(configWithRequest.status).toBe(200)
      const requestedAssignment = assignmentById(configWithRequest, assignment.id)
      expect(Boolean(requestedAssignment)).toBe(true)
      expect(requestedAssignment).toMatchObject({
        student_access_request: {
          student_name: 'Ada Lovelace',
          note: `Need help finishing paragraph ${index + 1}`,
        },
      })

      const approve = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          student_access_requests: {},
          student_temporary_access_until: {
            'ada lovelace': scenario.extensionMinute,
          },
        },
        { Cookie: login.cookie },
      )
      expect(approve.status).toBe(200)

      const approvedConfig = await studentAssignment(assignment.id, code, 'Ada Lovelace')
      expect(approvedConfig.status).toBe(200)
      expect(approvedConfig.body.assignment).toMatchObject({
        temporary_access_until: scenario.extensionMinute,
        student_access_request: null,
      })

      const graceConfig = await studentAssignment(assignment.id, code, 'Grace Hopper')
      if (scenario.assignedStudents.length) {
        expect(graceConfig.status).toBe(404)
        expect(graceConfig.body).toMatchObject({ error: 'Not found' })
      } else {
        expect(graceConfig.status).toBe(200)
        expect(graceConfig.body.assignment).toMatchObject({
          temporary_access_until: `2026-04-28T1${index}:00:00.000Z`,
        })
      }

      if (scenario.revokeAfterApprove) {
        const revoke = await request(
          'PUT',
          `/api/edu/assignments/${assignment.id}`,
          {
            student_access_revoked: {
              'ada lovelace': true,
            },
          },
          { Cookie: login.cookie },
        )
        expect(revoke.status).toBe(200)

        const revokedConfig = await studentConfig(code, 'Ada Lovelace')
        expect(revokedConfig.status).toBe(200)
        expect(assignmentById(revokedConfig, assignment.id)).toMatchObject({
          access_revoked: true,
          temporary_access_until: scenario.extensionMinute,
        })
      }
    })
  }

  const deletionCases = Array.from({ length: 6 }, (_, index) => ({
    deleteWholeClassroom: index % 2 === 0,
    publishReplay: index % 3 === 0,
  }))

  for (const [index, scenario] of deletionCases.entries()) {
    it(`deletion workflow ${index + 1} preserves teacher reads while removing student-facing assignment visibility`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('DEL', index)
      const classroom = await createClassroom(login, `Deletion workflow ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Deletion draft ${index + 1}`,
        assigned_students: ['Ada Lovelace'],
      })

      const liveSessionId = `delete-live:${index}:${randomUUID()}`
      const replayId = `delete-replay:${index}:${randomUUID()}`
      const currentText = `Delete me later ${index + 1}`

      const publish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: currentText }],
        minute: index + 20,
        replaySessionId: scenario.publishReplay ? replayId : null,
      })
      expect(publish.status).toBe(201)

      if (scenario.publishReplay) {
        const replayPublish = await publishReplay({
          id: replayId,
          live_session_id: liveSessionId,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          course: assignment.course,
          classroom: classroom.name,
          student_name: 'Ada Lovelace',
          current_text: currentText,
          document_history: [{ t: 100, text: currentText }],
        })
        expect(replayPublish.status).toBe(201)
      }

      const deleted = await request(
        'DELETE',
        scenario.deleteWholeClassroom
          ? `/api/edu/classrooms/${classroom.id}`
          : `/api/edu/assignments/${assignment.id}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(deleted.status).toBe(200)

      const studentRead = await studentConfig(code, 'Ada Lovelace')
      expect(studentRead.status).toBe(200)
      expect(assignmentById(studentRead, assignment.id)).toBeNull()

      const teacherLiveSession = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLiveSession.status).toBe(200)
      expect(teacherLiveSession.body).toMatchObject({
        id: liveSessionId,
        current_text: currentText,
      })

      if (scenario.publishReplay) {
        const replayRead = await request(
          'GET',
          `/api/edu/replays/${encodeURIComponent(replayId)}`,
          undefined,
          { Cookie: login.cookie },
        )
        expect(replayRead.status).toBe(200)
        expect(replayRead.body).toMatchObject({
          id: replayId,
          current_text: currentText,
          assignment: null,
        })
      }

      const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
        Cookie: login.cookie,
      })
      expect(dashboard.status).toBe(200)
      expect(dashboard.body.assignments).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: assignment.id })]),
      )
    })
  }

  const authCases = Array.from({ length: 5 }, (_, index) => ({
    email: `feature-teacher-${index + 1}@edu.handtyped.app`,
    name: `Feature Teacher ${index + 1}`,
    password: `feature-password-${index + 1}-long`,
  }))

  for (const [index, scenario] of authCases.entries()) {
    it(`auth workflow ${index + 1} keeps signup, session restore, logout, and teacher writes aligned`, async () => {
      const signup = await teacherSignup(scenario)
      expect(signup.status).toBe(201)
      expect(signup.body).toMatchObject({
        authenticated: true,
        teacher_email: scenario.email,
        teacher_name: scenario.name,
      })

      const restored = await request('GET', '/api/edu/auth/session', undefined, {
        Cookie: signup.cookie,
      })
      expect(restored.status).toBe(200)
      expect(restored.body).toMatchObject({
        authenticated: true,
        teacher_email: scenario.email,
        teacher_name: scenario.name,
      })

      const code = joinCode('AUT', index)
      const classroom = await request(
        'POST',
        '/api/edu/classrooms',
        {
          name: `Auth classroom ${index + 1}`,
          teacher_name: scenario.name,
          join_code: code,
        },
        { Cookie: signup.cookie },
      )
      expect(classroom.status).toBe(201)

      const assignment = await request(
        'POST',
        '/api/edu/assignments',
        {
          title: `Auth assignment ${index + 1}`,
          course: classroom.body.name,
          classroom_id: classroom.body.id,
          classroom_name: classroom.body.name,
          prompt: `Auth prompt ${index + 1}`,
        },
        { Cookie: signup.cookie },
      )
      expect(assignment.status).toBe(201)

      const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
        Cookie: signup.cookie,
      })
      expect(dashboard.status).toBe(200)
      expect(dashboard.body.classrooms).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: classroom.body.id, join_code: code })]),
      )
      expect(dashboard.body.assignments).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: assignment.body.id, title: `Auth assignment ${index + 1}` })]),
      )

      const logout = await request('POST', '/api/edu/auth/logout', undefined, {
        Cookie: signup.cookie,
      })
      expect(logout.status).toBe(200)
      expect(logout.body).toMatchObject({ authenticated: false })

      const unauthorized = await request('GET', '/api/edu/dashboard', undefined, {
        Cookie: signup.cookie,
      })
      expect(unauthorized.status).toBe(401)

      const relogin = await request(
        'POST',
        '/api/edu/auth/login',
        {
          provider: 'password',
          email: scenario.email,
          password: scenario.password,
        },
      )
      expect(relogin.status).toBe(200)
      expect(relogin.body).toMatchObject({
        authenticated: true,
        teacher_email: scenario.email,
      })
    })
  }

  const rosterCases = [
    { firstName: 'Ada Lovelace', secondName: 'Grace Hopper', expected: ['Ada Lovelace', 'Grace Hopper'] },
    { firstName: ' ada lovelace ', secondName: 'ADA LOVELACE', expected: ['ada lovelace'] },
    { firstName: 'Grace Hopper', secondName: 'Ada Lovelace', expected: ['Grace Hopper', 'Ada Lovelace'] },
    { firstName: 'Katherine Johnson', secondName: 'Dorothy Vaughan', expected: ['Katherine Johnson', 'Dorothy Vaughan'] },
    { firstName: 'Alan Turing', secondName: 'alan turing', expected: ['Alan Turing'] },
  ]

  for (const [index, scenario] of rosterCases.entries()) {
    it(`roster workflow ${index + 1} learns classroom membership from student config refreshes without duplicating names`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('ROS', index)
      const classroom = await createClassroom(login, `Roster workflow ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Roster draft ${index + 1}`,
        assigned_students: [],
      })

      const firstConfig = await studentConfig(code, scenario.firstName)
      const secondConfig = await studentConfig(code, scenario.secondName)
      const firstAssignment = await studentAssignment(assignment.id, code, scenario.firstName)
      expect(firstConfig.status).toBe(200)
      expect(secondConfig.status).toBe(200)
      expect(firstAssignment.status).toBe(200)

      const classroomRead = await request('GET', `/api/edu/classrooms/${classroom.id}`, undefined, {
        Cookie: login.cookie,
      })
      expect(classroomRead.status).toBe(200)
      expect(classroomRead.body.students).toEqual(scenario.expected)
    })
  }

  const feedbackCases = Array.from({ length: 5 }, (_, index) => ({
    gradeLabel: ['Revise', 'A-', 'B+', 'Complete', 'Check in'][index],
    replacement: ['clear thesis', 'stronger evidence', 'tighter paragraph', 'specific example', 'clean transition'][index],
    score: [79, 92, 87, 100, 84][index],
    returned: index % 2 === 0,
  }))

  for (const [index, scenario] of feedbackCases.entries()) {
    it(`feedback workflow ${index + 1} carries grading into student config, student assignment detail, and teacher live reads`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('FDB', index)
      const classroom = await createClassroom(login, `Feedback workflow ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Feedback draft ${index + 1}`,
        assigned_students: ['Ada Lovelace', 'Grace Hopper'],
      })

      const liveSessionId = `Ada Lovelace:${assignment.id}`
      const currentText = `Draft ${index + 1} needs revision`
      const publish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: currentText }],
        minute: index + 30,
      })
      expect(publish.status).toBe(201)

      const grading = await request(
        'PUT',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`,
        {
          rubric_scores: { clarity: index + 1, evidence: index + 2 },
          teacher_comment: `Feedback comment ${index + 1}`,
          returned_for_revision: scenario.returned,
          grade_label: scenario.gradeLabel,
          grade_score: scenario.score,
          inline_annotations: [
            {
              type: 'comment',
              start: 0,
              end: 5,
              quote: 'Draft',
              note: `Comment note ${index + 1}`,
            },
            {
              type: 'suggestion',
              start: 10,
              end: 18,
              quote: 'needs',
              replacement: scenario.replacement,
              note: `Suggestion note ${index + 1}`,
            },
          ],
        },
        { Cookie: login.cookie },
      )
      expect(grading.status).toBe(200)

      const adaConfig = await studentConfig(code, 'Ada Lovelace')
      const adaAssignment = await studentAssignment(assignment.id, code, 'Ada Lovelace')
      const graceConfig = await studentConfig(code, 'Grace Hopper')
      expect(adaConfig.status).toBe(200)
      expect(adaAssignment.status).toBe(200)
      expect(graceConfig.status).toBe(200)
      expect(assignmentById(adaConfig, assignment.id)).toMatchObject({
        student_feedback: expect.objectContaining({
          teacher_comment: `Feedback comment ${index + 1}`,
          returned_for_revision: scenario.returned,
          grade_label: scenario.gradeLabel,
          grade_score: String(scenario.score),
        }),
      })
      expect(adaAssignment.body.assignment).toMatchObject({
        student_feedback: expect.objectContaining({
          inline_annotations: expect.arrayContaining([
            expect.objectContaining({ type: 'comment', note: `Comment note ${index + 1}` }),
            expect.objectContaining({ type: 'suggestion', replacement: scenario.replacement }),
          ]),
        }),
      })
      expect(assignmentById(graceConfig, assignment.id)).toMatchObject({
        student_feedback: null,
      })

      const teacherLive = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLive.status).toBe(200)
      expect(teacherLive.body.grading).toMatchObject({
        teacher_comment: `Feedback comment ${index + 1}`,
        grade_label: scenario.gradeLabel,
      })
    })
  }

  const dashboardCases = Array.from({ length: 5 }, (_, index) => ({
    focusState: index % 2 === 0,
    hidActive: index % 3 !== 0,
    courseSuffix: index + 1,
  }))

  for (const [index, scenario] of dashboardCases.entries()) {
    it(`dashboard workflow ${index + 1} reports assignment, live-session, and audit deltas after realistic updates`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('DBD', index)
      const classroom = await createClassroom(login, `Dashboard workflow ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Dashboard draft ${index + 1}`,
        prompt: `Dashboard prompt ${index + 1}`,
      })

      const firstDashboard = await request('GET', '/api/edu/dashboard', undefined, {
        Cookie: login.cookie,
      })
      expect(firstDashboard.status).toBe(200)

      const assignmentUpdate = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          title: `Dashboard final ${index + 1}`,
          instructions: `Updated instructions ${index + 1}`,
          browser_policy: {
            browser_enabled: true,
            home_url: `https://updates.example.org/${index + 1}`,
            allowed_domains: ['updates.example.org'],
          },
        },
        { Cookie: login.cookie },
      )
      expect(assignmentUpdate.status).toBe(200)

      const liveSessionId = `dashboard:${index}:${randomUUID()}`
      const livePublish = await publishLiveSession({
        liveSessionId,
        assignment: assignmentUpdate.body,
        classroom,
        currentText: `Dashboard text ${index + 1}`,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: `Dashboard text ${index + 1}` }],
        currentUrl: `https://updates.example.org/${index + 1}`,
        currentUrlTitle: `Source ${index + 1}`,
        urlHistory: [
          {
            t: 100,
            url: `https://updates.example.org/${index + 1}`,
            allowed: true,
            source: 'embedded_navigation',
          },
        ],
        minute: index + 40,
        focused: scenario.focusState,
        hidActive: scenario.hidActive,
      })
      expect(livePublish.status).toBe(201)

      const delta = await request(
        'GET',
        `/api/edu/dashboard/updates?since=${encodeURIComponent(firstDashboard.body.updated_at)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(delta.status).toBe(200)
      expect(delta.body.live_sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: liveSessionId,
            current_text: `Dashboard text ${index + 1}`,
            focused: scenario.focusState,
            hid_active: scenario.hidActive,
          }),
        ]),
      )
      expect(delta.body.assignment_audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assignment_id: assignment.id,
            summary: expect.stringContaining('Updated'),
          }),
        ]),
      )

      const audit = await request('GET', `/api/edu/assignments/${assignment.id}/audit`, undefined, {
        Cookie: login.cookie,
      })
      expect(audit.status).toBe(200)
      expect(audit.body[0].changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Title' }),
          expect.objectContaining({ label: 'Instructions' }),
          expect.objectContaining({ label: 'Browser policy' }),
        ]),
      )
    })
  }

  const classroomMutationCases = Array.from({ length: 5 }, (_, index) => ({
    renamedClassroom: `Renamed classroom ${index + 1}`,
    nextJoinCode: joinCode('NXT', index),
    studentName: index % 2 === 0 ? 'Ada Lovelace' : 'Grace Hopper',
  }))

  for (const [index, scenario] of classroomMutationCases.entries()) {
    it(`classroom mutation workflow ${index + 1} refreshes renamed classrooms and updated join codes across student and teacher reads`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const originalCode = joinCode('CLS', index)
      const classroom = await createClassroom(login, `Original classroom ${index + 1}`, originalCode)
      const assignment = await createAssignment(login, classroom, {
        title: `Classroom mutation draft ${index + 1}`,
        assigned_students: [],
      })

      const beforeConfig = await studentConfig(originalCode, scenario.studentName)
      expect(beforeConfig.status).toBe(200)
      expect(beforeConfig.body.classroom).toMatchObject({
        id: classroom.id,
        join_code: originalCode,
        name: `Original classroom ${index + 1}`,
      })
      expect(assignmentById(beforeConfig, assignment.id)).toMatchObject({ id: assignment.id })

      const updatedClassroom = await request(
        'PUT',
        `/api/edu/classrooms/${classroom.id}`,
        {
          name: scenario.renamedClassroom,
          join_code: scenario.nextJoinCode.toLowerCase(),
        },
        { Cookie: login.cookie },
      )
      expect(updatedClassroom.status).toBe(200)
      expect(updatedClassroom.body).toMatchObject({
        id: classroom.id,
        name: scenario.renamedClassroom,
        join_code: scenario.nextJoinCode,
      })

      const staleConfig = await studentConfig(originalCode, scenario.studentName)
      expect(staleConfig.status).toBe(200)
      expect(staleConfig.body).toEqual({ classroom: null, assignments: [] })

      const refreshedConfig = await studentConfig(scenario.nextJoinCode, scenario.studentName)
      expect(refreshedConfig.status).toBe(200)
      expect(refreshedConfig.body.classroom).toMatchObject({
        id: classroom.id,
        join_code: scenario.nextJoinCode,
        name: scenario.renamedClassroom,
      })
      expect(assignmentById(refreshedConfig, assignment.id)).toMatchObject({
        id: assignment.id,
        classroom_name: `Original classroom ${index + 1}`,
      })

      const teacherRead = await request('GET', `/api/edu/classrooms/${classroom.id}`, undefined, {
        Cookie: login.cookie,
      })
      expect(teacherRead.status).toBe(200)
      expect(teacherRead.body).toMatchObject({
        id: classroom.id,
        join_code: scenario.nextJoinCode,
        name: scenario.renamedClassroom,
      })

      const dashboard = await request('GET', '/api/edu/dashboard', undefined, {
        Cookie: login.cookie,
      })
      expect(dashboard.status).toBe(200)
      expect(dashboard.body.classrooms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: classroom.id,
            join_code: scenario.nextJoinCode,
            name: scenario.renamedClassroom,
          }),
        ]),
      )
    })
  }

  const liveSummaryCases = Array.from({ length: 5 }, (_, index) => ({
    firstStudent: 'Ada Lovelace',
    secondStudent: 'Grace Hopper',
    firstFocused: index % 2 === 0,
    secondFocused: index % 3 === 0,
  }))

  for (const [index, scenario] of liveSummaryCases.entries()) {
    it(`live summary workflow ${index + 1} keeps assignment summaries and dashboard deltas aligned after repeated student updates`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('SUM', index)
      const classroom = await createClassroom(login, `Live summary ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Live summary draft ${index + 1}`,
        assigned_students: [],
      })

      const beforeDashboard = await request('GET', '/api/edu/dashboard', undefined, {
        Cookie: login.cookie,
      })
      expect(beforeDashboard.status).toBe(200)

      const firstLiveId = `${scenario.firstStudent}:${assignment.id}`
      const secondLiveId = `${scenario.secondStudent}:${assignment.id}`

      const firstPublish = await publishLiveSession({
        liveSessionId: firstLiveId,
        assignment,
        classroom,
        studentName: scenario.firstStudent,
        currentText: `Opening draft ${index + 1}`,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: `Opening draft ${index + 1}` }],
        urlHistory: [{ t: 130, url: `https://example.org/start-${index + 1}`, allowed: true, source: 'embedded_navigation' }],
        currentUrl: `https://example.org/start-${index + 1}`,
        currentUrlTitle: `Start ${index + 1}`,
        minute: index + 50,
        focused: scenario.firstFocused,
      })
      const secondPublish = await publishLiveSession({
        liveSessionId: secondLiveId,
        assignment,
        classroom,
        studentName: scenario.secondStudent,
        currentText: `Second writer ${index + 1}`,
        documentHistory: [{ t: 140, pos: 0, del: '', ins: `Second writer ${index + 1}` }],
        urlHistory: [{ t: 150, url: `https://example.org/second-${index + 1}`, allowed: true, source: 'embedded_navigation' }],
        currentUrl: `https://example.org/second-${index + 1}`,
        currentUrlTitle: `Second ${index + 1}`,
        minute: index + 51,
        focused: scenario.secondFocused,
      })
      expect(firstPublish.status).toBe(201)
      expect(secondPublish.status).toBe(201)

      const revisedFirst = await publishLiveSession({
        liveSessionId: firstLiveId,
        assignment,
        classroom,
        studentName: scenario.firstStudent,
        currentText: `Opening draft ${index + 1}\n\nRevision`,
        documentHistory: [
          { t: 100, pos: 0, del: '', ins: `Opening draft ${index + 1}` },
          { t: 260, pos: `Opening draft ${index + 1}`.length, del: '', ins: '\n\nRevision' },
        ],
        urlHistory: [
          { t: 130, url: `https://example.org/start-${index + 1}`, allowed: true, source: 'embedded_navigation' },
          { t: 280, url: `https://example.org/revision-${index + 1}`, allowed: true, source: 'embedded_navigation' },
        ],
        currentUrl: `https://example.org/revision-${index + 1}`,
        currentUrlTitle: `Revision ${index + 1}`,
        minute: index + 52,
        focused: true,
      })
      expect(revisedFirst.status).toBe(201)

      const summaries = await request(
        'GET',
        `/api/edu/assignments/${assignment.id}/live-summaries`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(summaries.status).toBe(200)
      expect(summaries.body.live_sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: firstLiveId,
            student_name: scenario.firstStudent,
            current_text: `Opening draft ${index + 1}\n\nRevision`,
            focused: true,
            recent_edit_count: expect.any(Number),
          }),
          expect.objectContaining({
            id: secondLiveId,
            student_name: scenario.secondStudent,
            current_text: `Second writer ${index + 1}`,
            focused: scenario.secondFocused,
            recent_edit_count: expect.any(Number),
          }),
        ]),
      )
      expect(summaries.body.live_sessions.every((session) => session.document_history === undefined)).toBe(true)
      expect(
        summaries.body.live_sessions.find((session) => session.id === firstLiveId)?.url_history?.length ?? 0,
      ).toBeLessThanOrEqual(4)

      const delta = await request(
        'GET',
        `/api/edu/dashboard/updates?since=${encodeURIComponent(beforeDashboard.body.updated_at)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(delta.status).toBe(200)
      expect(delta.body.live_sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: firstLiveId,
            current_text: `Opening draft ${index + 1}\n\nRevision`,
          }),
          expect.objectContaining({
            id: secondLiveId,
            current_text: `Second writer ${index + 1}`,
          }),
        ]),
      )
    })
  }

  const joinCodeConflictCases = Array.from({ length: 5 }, (_, index) => ({
    originalCode: joinCode('JCC', index),
    conflictingCode: joinCode('JCD', index),
  }))

  for (const [index, scenario] of joinCodeConflictCases.entries()) {
    it(`join code conflict workflow ${index + 1} rejects duplicate classroom codes without disturbing existing student reads`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const firstClassroom = await createClassroom(login, `Conflict first ${index + 1}`, scenario.originalCode)
      const secondClassroom = await createClassroom(login, `Conflict second ${index + 1}`, scenario.conflictingCode)
      await createAssignment(login, firstClassroom, {
        title: `Conflict assignment ${index + 1}`,
        assigned_students: [],
      })

      const duplicateCreate = await request(
        'POST',
        '/api/edu/classrooms',
        {
          name: `Duplicate create ${index + 1}`,
          teacher_name: 'Ms. Keating',
          join_code: scenario.originalCode.toLowerCase(),
        },
        { Cookie: login.cookie },
      )
      expect(duplicateCreate.status).toBe(409)
      expect(duplicateCreate.body).toMatchObject({
        error: 'Join code already in use',
        join_code: scenario.originalCode,
      })

      const duplicateRename = await request(
        'PUT',
        `/api/edu/classrooms/${secondClassroom.id}`,
        {
          join_code: scenario.originalCode.toLowerCase(),
        },
        { Cookie: login.cookie },
      )
      expect(duplicateRename.status).toBe(409)
      expect(duplicateRename.body).toMatchObject({
        error: 'Join code already in use',
        join_code: scenario.originalCode,
      })

      const originalConfig = await studentConfig(scenario.originalCode, 'Ada Lovelace')
      const conflictingConfig = await studentConfig(scenario.conflictingCode, 'Grace Hopper')
      expect(originalConfig.status).toBe(200)
      expect(conflictingConfig.status).toBe(200)
      expect(originalConfig.body.classroom).toMatchObject({
        id: firstClassroom.id,
        join_code: scenario.originalCode,
      })
      expect(conflictingConfig.body.classroom).toMatchObject({
        id: secondClassroom.id,
        join_code: scenario.conflictingCode,
      })
    })
  }

  const deletedSummaryCases = Array.from({ length: 5 }, (_, index) => ({
    deleteWholeClassroom: index % 2 === 0,
  }))

  for (const [index, scenario] of deletedSummaryCases.entries()) {
    it(`deleted summary workflow ${index + 1} removes teacher summary endpoints while preserving saved live sessions`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('GON', index)
      const classroom = await createClassroom(login, `Gone summary ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Gone assignment ${index + 1}`,
        assigned_students: [],
      })
      const liveSessionId = `gone-summary:${index}:${randomUUID()}`

      const publish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        studentName: 'Ada Lovelace',
        currentText: `Saved live draft ${index + 1}`,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: `Saved live draft ${index + 1}` }],
        minute: index + 60,
      })
      expect(publish.status).toBe(201)

      const beforeSummaries = await request(
        'GET',
        `/api/edu/assignments/${assignment.id}/live-summaries`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(beforeSummaries.status).toBe(200)
      expect(beforeSummaries.body.live_sessions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: liveSessionId })]),
      )

      const deleted = await request(
        'DELETE',
        scenario.deleteWholeClassroom
          ? `/api/edu/classrooms/${classroom.id}`
          : `/api/edu/assignments/${assignment.id}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(deleted.status).toBe(200)

      const afterSummaries = await request(
        'GET',
        `/api/edu/assignments/${assignment.id}/live-summaries`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(afterSummaries.status).toBe(404)

      const teacherLive = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLive.status).toBe(200)
      expect(teacherLive.body).toMatchObject({
        id: liveSessionId,
        current_text: `Saved live draft ${index + 1}`,
      })

      const studentRead = await studentAssignment(assignment.id, code, 'Ada Lovelace')
      expect(studentRead.status).toBe(404)
    })
  }

  const refreshCases = Array.from({ length: 8 }, (_, index) => ({
    browserEnabled: index % 3 !== 0,
    includeLinkedReference: index % 2 === 0,
    overrideBrowserOff: index % 4 === 0,
    assignedStudents: index % 2 === 0 ? ['Ada Lovelace'] : [],
  }))

  for (const [index, scenario] of refreshCases.entries()) {
    it(`mid-session refresh workflow ${index + 1} keeps student assignment updates and teacher live text aligned`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('RFR', index)
      const classroom = await createClassroom(login, `Refresh workflow ${index + 1}`, code)
      const linkedAssignment = scenario.includeLinkedReference
        ? await createAssignment(login, classroom, {
            title: `Reference notebook ${index + 1}`,
            prompt: `Reference notebook prompt ${index + 1}`,
          })
        : null
      const assignment = await createAssignment(login, classroom, {
        title: `Refresh draft ${index + 1}`,
        prompt: `Original prompt ${index + 1}`,
        assigned_students: scenario.assignedStudents,
        browser_policy: {
          browser_enabled: false,
          home_url: '',
          allowed_domains: [],
        },
      })
      const liveSessionId = `refresh:${index}:${randomUUID()}`
      const firstText = `Opening draft ${index + 1}`
      const secondText = `${firstText}\n\nRevision after teacher update ${index + 1}.`

      const firstPublish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText: firstText,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: firstText }],
        minute: index + 70,
      })
      expect(firstPublish.status).toBe(201)

      const updatedTitle = `Refresh draft ${index + 1} revised`
      const updatedPrompt = `Updated prompt ${index + 1}`
      const updatedHome = `https://example.org/home-${index + 1}`
      const updateAssignment = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          title: updatedTitle,
          prompt: updatedPrompt,
          policy: {
            allow_offline_editing: scenario.browserEnabled,
            copy_paste_allowed: index % 2 === 1,
          },
          browser_policy: {
            browser_enabled: scenario.browserEnabled,
            home_url: scenario.browserEnabled ? updatedHome : '',
            allowed_domains: scenario.browserEnabled ? ['example.org'] : [],
          },
          linked_assignment_ids: linkedAssignment ? [linkedAssignment.id] : [],
          temporary_access_until: `2026-04-28T2${index}:45:00.000Z`,
          student_overrides: scenario.overrideBrowserOff
            ? {
                'ada lovelace': {
                  student_name: 'Ada Lovelace',
                  browser_policy: {
                    browser_enabled: false,
                    home_url: '',
                    allowed_domains: [],
                  },
                },
              }
            : {},
        },
        { Cookie: login.cookie },
      )
      expect(updateAssignment.status).toBe(200)

      const config = await studentConfig(code, 'Ada Lovelace')
      const detail = await studentAssignment(assignment.id, code, 'Ada Lovelace')
      expect(config.status).toBe(200)
      expect(detail.status).toBe(200)
      expect(assignmentById(config, assignment.id)).toMatchObject({
        title: updatedTitle,
        prompt: updatedPrompt,
        temporary_access_until: `2026-04-28T2${index}:45:00.000Z`,
        linked_assignment_ids: linkedAssignment ? [linkedAssignment.id] : [],
      })
      expect(detail.body.assignment).toMatchObject({
        title: updatedTitle,
        prompt: updatedPrompt,
        linked_assignment_ids: linkedAssignment ? [linkedAssignment.id] : [],
      })
      expect(detail.body.assignment.browser_policy).toMatchObject({
        browser_enabled: scenario.overrideBrowserOff ? false : scenario.browserEnabled,
      })
      if (scenario.overrideBrowserOff) {
        expect(detail.body.assignment.browser_policy.home_url || '').toBe('')
      } else if (scenario.browserEnabled) {
        expect(detail.body.assignment.browser_policy.home_url || '').toBe(updatedHome)
      } else {
        expect(typeof detail.body.assignment.browser_policy.home_url).toBe('string')
        expect(detail.body.assignment.browser_policy.home_url).toBe('')
      }

      const teacherLiveBeforeRepublish = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLiveBeforeRepublish.status).toBe(200)
      expect(teacherLiveBeforeRepublish.body).toMatchObject({
        id: liveSessionId,
        current_text: firstText,
      })

      const secondPublish = await publishLiveSession({
        liveSessionId,
        assignment: { ...assignment, title: updatedTitle },
        classroom,
        currentText: secondText,
        documentHistory: [
          { t: 100, pos: 0, del: '', ins: firstText },
          { t: 240, pos: firstText.length, del: '', ins: `\n\nRevision after teacher update ${index + 1}.` },
        ],
        currentUrl: scenario.browserEnabled ? updatedHome : null,
        currentUrlTitle: scenario.browserEnabled ? `Home ${index + 1}` : null,
        minute: index + 90,
      })
      expect(secondPublish.status).toBe(201)

      const teacherLiveAfterRepublish = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLiveAfterRepublish.status).toBe(200)
      expect(teacherLiveAfterRepublish.body).toMatchObject({
        id: liveSessionId,
        assignment_id: assignment.id,
        assignment_title: updatedTitle,
        current_text: secondText,
      })

      const summaries = await request(
        'GET',
        `/api/edu/assignments/${assignment.id}/live-summaries`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(summaries.status).toBe(200)
      expect(summaries.body.live_sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: liveSessionId,
            current_text: secondText,
          }),
        ]),
      )
    })
  }

  const regradingCases = Array.from({ length: 8 }, (_, index) => ({
    firstReturned: index % 2 === 0,
    secondReturned: index % 3 === 0,
    firstScore: 76 + index,
    secondScore: 84 + index,
  }))

  for (const [index, scenario] of regradingCases.entries()) {
    it(`regrading workflow ${index + 1} replaces old feedback across teacher and student surfaces`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('RGR', index)
      const classroom = await createClassroom(login, `Regrade workflow ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Regrade draft ${index + 1}`,
        assigned_students: ['Ada Lovelace'],
      })
      const liveSessionId = `Ada Lovelace:${assignment.id}`
      const currentText = `Revision target ${index + 1}`

      const publish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: currentText }],
        minute: index + 100,
      })
      expect(publish.status).toBe(201)

      const firstReplacement = `stronger opening ${index + 1}`
      const firstGrading = await request(
        'PUT',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`,
        {
          teacher_comment: `First feedback ${index + 1}`,
          returned_for_revision: scenario.firstReturned,
          grade_label: 'Revise',
          grade_score: scenario.firstScore,
          inline_annotations: [
            {
              type: 'suggestion',
              start: 0,
              end: 8,
              quote: 'Revision',
              replacement: firstReplacement,
              note: `First suggestion ${index + 1}`,
            },
          ],
        },
        { Cookie: login.cookie },
      )
      expect(firstGrading.status).toBe(200)

      const secondReplacement = `finalized claim ${index + 1}`
      const secondGrading = await request(
        'PUT',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`,
        {
          teacher_comment: `Second feedback ${index + 1}`,
          returned_for_revision: scenario.secondReturned,
          grade_label: 'Published',
          grade_score: scenario.secondScore,
          inline_annotations: [
            {
              type: 'comment',
              start: 0,
              end: 8,
              quote: 'Revision',
              note: `Second comment ${index + 1}`,
            },
            {
              type: 'suggestion',
              start: 9,
              end: 15,
              quote: 'target',
              replacement: secondReplacement,
              note: `Second suggestion ${index + 1}`,
            },
          ],
        },
        { Cookie: login.cookie },
      )
      expect(secondGrading.status).toBe(200)

      const teacherLive = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLive.status).toBe(200)
      expect(teacherLive.body.grading).toMatchObject({
        teacher_comment: `Second feedback ${index + 1}`,
        returned_for_revision: scenario.secondReturned,
        grade_label: 'Published',
        grade_score: scenario.secondScore,
      })
      expect(teacherLive.body.grading.inline_annotations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'comment', note: `Second comment ${index + 1}` }),
          expect.objectContaining({ type: 'suggestion', replacement: secondReplacement }),
        ]),
      )
      expect(teacherLive.body.grading.inline_annotations).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ replacement: firstReplacement })]),
      )

      const studentConfigAda = await studentConfig(code, 'Ada Lovelace')
      const studentAssignmentAda = await studentAssignment(assignment.id, code, 'Ada Lovelace')
      const studentConfigGrace = await studentConfig(code, 'Grace Hopper')
      expect(studentConfigAda.status).toBe(200)
      expect(studentAssignmentAda.status).toBe(200)
      expect(studentConfigGrace.status).toBe(200)

      expect(assignmentById(studentConfigAda, assignment.id)).toMatchObject({
        student_feedback: expect.objectContaining({
          teacher_comment: `Second feedback ${index + 1}`,
          returned_for_revision: scenario.secondReturned,
          grade_label: 'Published',
          grade_score: String(scenario.secondScore),
        }),
      })
      expect(studentAssignmentAda.body.assignment.student_feedback.inline_annotations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'comment', note: `Second comment ${index + 1}` }),
          expect.objectContaining({ type: 'suggestion', replacement: secondReplacement }),
        ]),
      )
      expect(studentAssignmentAda.body.assignment.student_feedback.inline_annotations).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ replacement: firstReplacement })]),
      )
      expect(assignmentById(studentConfigGrace, assignment.id)).toBeNull()
    })
  }

  const visibilityChurnCases = Array.from({ length: 8 }, (_, index) => ({
    startTargets: index % 2 === 0 ? ['Ada Lovelace'] : [],
    endTargets: index % 3 === 0 ? ['Grace Hopper'] : ['Ada Lovelace', 'Grace Hopper'],
    revokeAda: index % 4 === 0,
  }))

  for (const [index, scenario] of visibilityChurnCases.entries()) {
    it(`visibility churn workflow ${index + 1} preserves teacher monitoring while student visibility changes after writing starts`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('VIS', index)
      const classroom = await createClassroom(login, `Visibility churn ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Visibility draft ${index + 1}`,
        assigned_students: scenario.startTargets,
      })
      const liveSessionId = `visibility:${index}:${randomUUID()}`
      const currentText = `Visibility draft start ${index + 1}`

      const firstVisibleStudent = scenario.startTargets.length ? 'Ada Lovelace' : 'Grace Hopper'
      const beforeConfig = await studentAssignment(assignment.id, code, firstVisibleStudent)
      expect(beforeConfig.status).toBe(200)

      const publish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        studentName: 'Ada Lovelace',
        currentText,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: currentText }],
        minute: index + 120,
      })
      expect(publish.status).toBe(201)

      const update = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          assigned_students: scenario.endTargets,
          student_access_revoked: scenario.revokeAda ? { 'ada lovelace': true } : {},
        },
        { Cookie: login.cookie },
      )
      expect(update.status).toBe(200)

      const adaDetail = await studentAssignment(assignment.id, code, 'Ada Lovelace')
      if (
        scenario.revokeAda &&
        (scenario.endTargets.includes('Ada Lovelace') || scenario.endTargets.length === 0)
      ) {
        expect(adaDetail.status).toBe(200)
        expect(adaDetail.body.assignment).toMatchObject({
          access_revoked: true,
        })
      } else if (scenario.endTargets.includes('Ada Lovelace') || scenario.endTargets.length === 0) {
        expect(adaDetail.status).toBe(200)
      } else {
        expect(adaDetail.status).toBe(404)
      }

      const graceDetail = await studentAssignment(assignment.id, code, 'Grace Hopper')
      if (scenario.endTargets.includes('Grace Hopper') || scenario.endTargets.length === 0) {
        expect(graceDetail.status).toBe(200)
      } else {
        expect(graceDetail.status).toBe(404)
      }

      const teacherLive = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLive.status).toBe(200)
      expect(teacherLive.body).toMatchObject({
        id: liveSessionId,
        current_text: currentText,
        student_name: 'Ada Lovelace',
      })

      const summaries = await request(
        'GET',
        `/api/edu/assignments/${assignment.id}/live-summaries`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(summaries.status).toBe(200)
      expect(summaries.body.live_sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: liveSessionId,
            current_text: currentText,
          }),
        ]),
      )
    })
  }
})
