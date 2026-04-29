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

function joinCode(prefix, index) {
  return `${prefix}${String(index + 1).padStart(2, '0')}${JOIN_CODE_SUFFIX}`
}

function ts(minute) {
  return `2026-04-28T16:${String(minute).padStart(2, '0')}:00.000Z`
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
      title: overrides.title || 'Workflow draft',
      course: overrides.course || classroom.name,
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      prompt: overrides.prompt || 'Write a draft.',
      assigned_students: overrides.assigned_students,
      policy: overrides.policy,
      browser_policy: overrides.browser_policy,
    },
    { Cookie: login.cookie },
  )
  expect(response.status).toBe(201)
  return response.body
}

async function studentConfig(code, studentName) {
  const encoded = encodeURIComponent(studentName)
  return request('GET', `/api/edu/student/config?join_code=${code}&student_name=${encoded}`)
}

async function publishLiveSession({
  liveSessionId,
  assignment,
  classroom,
  studentName = 'Ada Lovelace',
  currentText,
  documentHistory,
  minute,
  focused = true,
  hidActive = true,
  scheduleOpen = true,
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
    current_url: null,
    current_url_title: null,
    url_history: [],
    violation_count: 0,
    violations: [],
    last_activity_at: ts(minute),
    schedule_open: scheduleOpen,
    focused,
    hid_active: hidActive,
  })
}

async function gradeLiveSession(login, liveSessionId, body) {
  return request(
    'PUT',
    `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}/grading`,
    body,
    { Cookie: login.cookie },
  )
}

function assignmentById(config, assignmentId) {
  return (config.body.assignments || []).find((item) => item.id === assignmentId) || null
}

beforeAll(async () => {
  sessionsDir = join(__dirname, `edu-workflow-matrix-${randomUUID()}`)
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

describe('workflow matrix almost end-to-end', () => {
  const visibilityCases = [
    { from: ['Ada Lovelace'], to: ['Grace Hopper'], beforeAda: true, beforeGrace: false, afterAda: false, afterGrace: true },
    { from: [], to: ['Ada Lovelace'], beforeAda: true, beforeGrace: true, afterAda: true, afterGrace: false },
    { from: ['Ada Lovelace', 'Grace Hopper'], to: ['Ada Lovelace'], beforeAda: true, beforeGrace: true, afterAda: true, afterGrace: false },
    { from: ['Grace Hopper'], to: [], beforeAda: false, beforeGrace: true, afterAda: true, afterGrace: true },
    { from: ['Ada Lovelace'], to: ['Ada Lovelace', 'Grace Hopper'], beforeAda: true, beforeGrace: false, afterAda: true, afterGrace: true },
    { from: ['Grace Hopper'], to: ['Ada Lovelace'], beforeAda: false, beforeGrace: true, afterAda: true, afterGrace: false },
    { from: [], to: ['Grace Hopper'], beforeAda: true, beforeGrace: true, afterAda: false, afterGrace: true },
    { from: ['Ada Lovelace', 'Grace Hopper'], to: ['Grace Hopper'], beforeAda: true, beforeGrace: true, afterAda: false, afterGrace: true },
    { from: ['Ada Lovelace'], to: [], beforeAda: true, beforeGrace: false, afterAda: true, afterGrace: true },
    { from: ['Grace Hopper'], to: ['Ada Lovelace', 'Grace Hopper'], beforeAda: false, beforeGrace: true, afterAda: true, afterGrace: true },
  ]

  for (const [index, scenario] of visibilityCases.entries()) {
    it(`visibility workflow ${index + 1} refreshes targeted assignment visibility correctly`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('VIS', index)
      const classroom = await createClassroom(login, `Visibility ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Visibility draft ${index + 1}`,
        prompt: `Visibility prompt ${index + 1}`,
        assigned_students: scenario.from,
      })

      const beforeAda = await studentConfig(code, 'Ada Lovelace')
      const beforeGrace = await studentConfig(code, 'Grace Hopper')
      expect(Boolean(assignmentById(beforeAda, assignment.id))).toBe(scenario.beforeAda)
      expect(Boolean(assignmentById(beforeGrace, assignment.id))).toBe(scenario.beforeGrace)

      const update = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          assigned_students: scenario.to,
          prompt: `Updated visibility prompt ${index + 1}`,
        },
        { Cookie: login.cookie },
      )
      expect(update.status).toBe(200)

      const afterAda = await studentConfig(code, 'Ada Lovelace')
      const afterGrace = await studentConfig(code, 'Grace Hopper')
      expect(Boolean(assignmentById(afterAda, assignment.id))).toBe(scenario.afterAda)
      expect(Boolean(assignmentById(afterGrace, assignment.id))).toBe(scenario.afterGrace)
    })
  }

  const metadataCases = Array.from({ length: 10 }, (_, index) => ({
    initialTitle: `Metadata draft ${index + 1}`,
    updatedTitle: `Metadata final ${index + 1}`,
    initialPrompt: `Initial prompt ${index + 1}`,
    updatedPrompt: `Updated prompt ${index + 1}`,
    policy: {
      allow_offline_editing: index % 2 === 0,
      copy_paste_allowed: index % 3 === 0,
      export_allowed: index % 2 === 1,
    },
    updatedPolicy: {
      allow_offline_editing: index % 2 !== 0,
      copy_paste_allowed: index % 3 !== 0,
      export_allowed: index % 2 === 0,
    },
  }))

  for (const [index, scenario] of metadataCases.entries()) {
    it(`metadata workflow ${index + 1} refreshes updated assignment settings without losing the current live draft`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('MET', index)
      const classroom = await createClassroom(login, `Metadata ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: scenario.initialTitle,
        prompt: scenario.initialPrompt,
        assigned_students: ['Ada Lovelace'],
        policy: scenario.policy,
      })

      const liveSessionId = `metadata:${index}:${randomUUID()}`
      const currentText = `Draft body ${index + 1}`
      const publish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: currentText }],
        minute: index,
      })
      expect(publish.status).toBe(201)

      const update = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          title: scenario.updatedTitle,
          prompt: scenario.updatedPrompt,
          policy: scenario.updatedPolicy,
        },
        { Cookie: login.cookie },
      )
      expect(update.status).toBe(200)

      const adaConfig = await studentConfig(code, 'Ada Lovelace')
      expect(adaConfig.status).toBe(200)
      expect(assignmentById(adaConfig, assignment.id)).toMatchObject({
        title: scenario.updatedTitle,
        prompt: scenario.updatedPrompt,
        policy: expect.objectContaining(scenario.updatedPolicy),
      })

      const teacherLiveView = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLiveView.status).toBe(200)
      expect(teacherLiveView.body.current_text).toBe(currentText)
    })
  }

  const liveCases = Array.from({ length: 10 }, (_, index) => ({
    drafts: [
      `Opening line ${index + 1}.`,
      `Opening line ${index + 1}.\n\nRevision pass ${index + 1}.`,
      `Opening line ${index + 1}.\n\nRevision pass ${index + 1}.\n\nFinal note ${index + 1}.`,
    ],
    blankClose: index % 2 === 0,
  }))

  for (const [index, scenario] of liveCases.entries()) {
    it(`live draft workflow ${index + 1} preserves the latest draft across revisions${scenario.blankClose ? ' and blank closes' : ''}`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('LIV', index)
      const classroom = await createClassroom(login, `Live Draft ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Live draft ${index + 1}`,
        assigned_students: ['Ada Lovelace'],
      })
      const liveSessionId = `live:${index}:${randomUUID()}`

      for (const [draftIndex, draft] of scenario.drafts.entries()) {
        const response = await publishLiveSession({
          liveSessionId,
          assignment,
          classroom,
          currentText: draft,
          documentHistory: [{ t: 100 + draftIndex * 250, pos: 0, del: '', ins: draft }],
          minute: 10 + index + draftIndex,
        })
        expect(response.status).toBe(201)
      }

      if (scenario.blankClose) {
        const closePublish = await publishLiveSession({
          liveSessionId,
          assignment,
          classroom,
          currentText: '',
          documentHistory: [],
          minute: 20 + index,
          focused: false,
          hidActive: false,
          scheduleOpen: false,
        })
        expect(closePublish.status).toBe(201)
        expect(closePublish.body.current_text).toBe(scenario.drafts.at(-1))
      }

      const persisted = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(persisted.status).toBe(200)
      expect(persisted.body.current_text).toBe(scenario.drafts.at(-1))
    })
  }

  const gradingCases = Array.from({ length: 10 }, (_, index) => ({
    teacher_comment: `Teacher comment ${index + 1}`,
    grade_label: index % 2 === 0 ? 'Revise' : 'A-',
    grade_score: 80 + index,
    replacementA: `replacement-${index + 1}-a`,
    replacementB: `replacement-${index + 1}-b`,
  }))

  for (const [index, scenario] of gradingCases.entries()) {
    it(`grading workflow ${index + 1} persists teacher feedback into teacher and student reads`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('GRD', index)
      const classroom = await createClassroom(login, `Grading ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Grading draft ${index + 1}`,
        assigned_students: ['Ada Lovelace'],
      })
      const liveSessionId = `grading:${index}:${randomUUID()}`

      const publish = await publishLiveSession({
        liveSessionId,
        assignment,
        classroom,
        currentText: `Draft needing suggestions ${index + 1}.`,
        documentHistory: [{ t: 100, pos: 0, del: '', ins: `Draft needing suggestions ${index + 1}.` }],
        minute: 30 + index,
      })
      expect(publish.status).toBe(201)

      const grading = await gradeLiveSession(login, liveSessionId, {
        teacher_comment: scenario.teacher_comment,
        returned_for_revision: true,
        grade_label: scenario.grade_label,
        grade_score: scenario.grade_score,
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
            start: 6,
            end: 13,
            quote: 'needing',
            replacement: scenario.replacementA,
            note: `Suggestion note A ${index + 1}`,
          },
          {
            type: 'suggestion',
            start: 14,
            end: 25,
            quote: 'suggestions',
            replacement: scenario.replacementB,
            note: `Suggestion note B ${index + 1}`,
          },
        ],
      })
      expect(grading.status).toBe(200)

      const teacherLiveView = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLiveView.status).toBe(200)
      expect(teacherLiveView.body.grading).toMatchObject({
        teacher_comment: scenario.teacher_comment,
        returned_for_revision: true,
      })
      expect(teacherLiveView.body.grading.inline_annotations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'suggestion', replacement: scenario.replacementA }),
          expect.objectContaining({ type: 'suggestion', replacement: scenario.replacementB }),
        ]),
      )

      const adaConfig = await studentConfig(code, 'Ada Lovelace')
      expect(adaConfig.status).toBe(200)
      expect(assignmentById(adaConfig, assignment.id)?.student_feedback).toMatchObject({
        teacher_comment: scenario.teacher_comment,
        returned_for_revision: true,
      })
      expect(assignmentById(adaConfig, assignment.id)?.student_feedback?.inline_annotations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'suggestion', replacement: scenario.replacementA }),
          expect.objectContaining({ type: 'suggestion', replacement: scenario.replacementB }),
        ]),
      )
    })
  }

  const combinedCases = Array.from({ length: 10 }, (_, index) => ({
    initialTitle: `Combined draft ${index + 1}`,
    updatedTitle: `Combined final ${index + 1}`,
    revisedText: `Combined revised text ${index + 1}.`,
    replacement: `combined-replacement-${index + 1}`,
  }))

  for (const [index, scenario] of combinedCases.entries()) {
    it(`combined workflow ${index + 1} keeps assignment updates, suggestions, and later revisions aligned`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('CMB', index)
      const classroom = await createClassroom(login, `Combined ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: scenario.initialTitle,
        prompt: `Initial combined prompt ${index + 1}`,
        assigned_students: ['Ada Lovelace'],
      })
      const liveSessionId = `combined:${index}:${randomUUID()}`

      const openingDraft = `Combined opening ${index + 1}.`
      expect(
        await publishLiveSession({
          liveSessionId,
          assignment,
          classroom,
          currentText: openingDraft,
          documentHistory: [{ t: 100, pos: 0, del: '', ins: openingDraft }],
          minute: 45 + index,
        }),
      ).toMatchObject({ status: 201 })

      const update = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          title: scenario.updatedTitle,
          prompt: `Updated combined prompt ${index + 1}`,
        },
        { Cookie: login.cookie },
      )
      expect(update.status).toBe(200)

      const grading = await gradeLiveSession(login, liveSessionId, {
        teacher_comment: `Combined comment ${index + 1}`,
        suggested_revisions: `Combined revision ${index + 1}`,
        returned_for_revision: true,
        grade_label: 'Revise',
        grade_score: 85 + index,
        inline_annotations: [
          {
            type: 'suggestion',
            start: 9,
            end: 16,
            quote: 'opening',
            replacement: scenario.replacement,
            note: `Combined note ${index + 1}`,
          },
        ],
      })
      expect(grading.status).toBe(200)

      const laterPublish = await publishLiveSession({
        liveSessionId,
        assignment: { ...assignment, title: scenario.updatedTitle },
        classroom,
        currentText: scenario.revisedText,
        documentHistory: [{ t: 300, pos: 0, del: openingDraft, ins: scenario.revisedText }],
        minute: 55 + index,
      })
      expect(laterPublish.status).toBe(201)
      expect(laterPublish.body.grading).toMatchObject({
        teacher_comment: `Combined comment ${index + 1}`,
        inline_annotations: [
          expect.objectContaining({ type: 'suggestion', replacement: scenario.replacement }),
        ],
      })

      const adaConfig = await studentConfig(code, 'Ada Lovelace')
      expect(adaConfig.status).toBe(200)
      expect(assignmentById(adaConfig, assignment.id)).toMatchObject({
        title: scenario.updatedTitle,
        prompt: `Updated combined prompt ${index + 1}`,
        student_feedback: expect.objectContaining({
          teacher_comment: `Combined comment ${index + 1}`,
          returned_for_revision: true,
          inline_annotations: expect.arrayContaining([
            expect.objectContaining({ type: 'suggestion', replacement: scenario.replacement }),
          ]),
        }),
      })

      const teacherLiveView = await request(
        'GET',
        `/api/edu/live-sessions/${encodeURIComponent(liveSessionId)}`,
        undefined,
        { Cookie: login.cookie },
      )
      expect(teacherLiveView.status).toBe(200)
      expect(teacherLiveView.body).toMatchObject({
        current_text: scenario.revisedText,
        grading: {
          teacher_comment: `Combined comment ${index + 1}`,
        },
      })
    })
  }

  const accessCases = Array.from({ length: 5 }, (_, index) => ({
    approvedUntil: `2026-04-28T1${index}:30:00.000Z`,
    note: `Need more time ${index + 1}`,
  }))

  for (const [index, scenario] of accessCases.entries()) {
    it(`access workflow ${index + 1} carries a student request into teacher approval and student refresh`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('ACC', index)
      const classroom = await createClassroom(login, `Access ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Access draft ${index + 1}`,
        assigned_students: ['Ada Lovelace'],
      })

      const accessRequest = await request(
        'POST',
        `/api/edu/assignments/${assignment.id}/access-requests`,
        {
          student_name: 'Ada Lovelace',
          note: scenario.note,
        },
      )
      expect(accessRequest.status).toBe(201)
      expect(accessRequest.body.student_access_request).toMatchObject({
        student_name: 'Ada Lovelace',
        note: scenario.note,
      })

      const approved = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          student_access_requests: {},
          student_temporary_access_until: {
            'ada lovelace': scenario.approvedUntil,
          },
        },
        { Cookie: login.cookie },
      )
      expect(approved.status).toBe(200)

      const adaConfig = await studentConfig(code, 'Ada Lovelace')
      expect(adaConfig.status).toBe(200)
      expect(assignmentById(adaConfig, assignment.id)).toMatchObject({
        temporary_access_until: scenario.approvedUntil,
        student_access_request: null,
      })

      const graceConfig = await studentConfig(code, 'Grace Hopper')
      expect(graceConfig.status).toBe(200)
      expect(Boolean(assignmentById(graceConfig, assignment.id))).toBe(false)
    })
  }

  const overrideFontSizes = [24, 28, 32, 20, 18]
  const overrideCases = Array.from({ length: 5 }, (_, index) => ({
    fontSize: overrideFontSizes[index],
    dictation: index % 2 === 0,
    copyPaste: index % 2 !== 0,
    browserEnabled: index % 3 === 0,
  }))

  for (const [index, scenario] of overrideCases.entries()) {
    it(`override workflow ${index + 1} keeps per-student policy and browser settings separated`, async () => {
      const login = await teacherLogin()
      expect(login.status).toBe(200)
      const code = joinCode('OVR', index)
      const classroom = await createClassroom(login, `Overrides ${index + 1}`, code)
      const assignment = await createAssignment(login, classroom, {
        title: `Override draft ${index + 1}`,
        assigned_students: [],
        policy: {
          allow_dictation: false,
          copy_paste_allowed: false,
        },
        browser_policy: {
          browser_enabled: true,
          home_url: 'https://example.org/source',
          allowed_domains: ['example.org'],
        },
      })

      const update = await request(
        'PUT',
        `/api/edu/assignments/${assignment.id}`,
        {
          student_overrides: {
            'ada lovelace': {
              student_name: 'Ada Lovelace',
              policy: {
                allow_dictation: scenario.dictation,
                copy_paste_allowed: scenario.copyPaste,
              },
              editor_policy: {
                font_size: scenario.fontSize,
              },
              browser_policy: {
                browser_enabled: scenario.browserEnabled,
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
        policy: {
          allow_dictation: scenario.dictation,
          copy_paste_allowed: scenario.copyPaste,
        },
        editor_policy: {
          font_size: scenario.fontSize,
        },
        browser_policy: {
          browser_enabled: scenario.browserEnabled,
        },
      })
      expect(assignmentById(graceConfig, assignment.id)).toMatchObject({
        policy: {
          allow_dictation: false,
          copy_paste_allowed: false,
        },
        browser_policy: {
          browser_enabled: true,
        },
      })
    })
  }
})
