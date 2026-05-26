import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Window } from 'happy-dom'
import { createApp } from './server-lib.js'
import {
  focusLossSummary,
  reviewDraftRenderMode,
  reviewDraftRenderSignature,
  studentRejoinHistorySummary,
} from './public/edu/app-ui.js'

const TEST_TEACHER_EMAIL = 'actual-teacher@edu.handtyped.app'
const TEST_TEACHER_PASSWORD = 'actual-teacher-password'

function stripBootstrapping(source) {
  return source
    .replace(/import\s*\{[\s\S]*?\}\s*from '\.\/app-ui\.js'\s*/m, '')
    .replace(/import\s*\{[\s\S]*?\}\s*from '\.\.\/replay-view\.js'\s*/m, '')
    .replace(/loadApp\(\)\.catch\(\(error\) => \{[\s\S]*?\}\)\s*$/m, '')
}

function createJsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body
    },
  }
}

async function startEduTestServer() {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handtyped-edu-tandem-'))
  const app = createApp(sessionsDir, {
    eduStoreDir: path.join(sessionsDir, 'edu-store'),
    trustedSignerKeys: [],
  })

  let server
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1')
    server.once('listening', resolve)
    server.once('error', reject)
  })

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      fs.rmSync(sessionsDir, { recursive: true, force: true })
    },
  }
}

async function apiJson(baseUrl, pathName, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(new URL(pathName, baseUrl), {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok) {
    throw new Error(`${method} ${pathName} failed with ${response.status}: ${JSON.stringify(data)}`)
  }
  return { response, body: data }
}

function teacherFetch(baseUrl, cookie) {
  return async (input, options = {}) => {
    const headers = new Headers(options.headers || {})
    if (cookie) {
      headers.set('Cookie', cookie)
    }
    return fetch(new URL(String(input), baseUrl), {
      ...options,
      headers,
    })
  }
}

async function createTeacherWorkspace(baseUrl, assignmentOverrides = {}) {
  await apiJson(baseUrl, '/api/edu/auth/signup', {
    method: 'POST',
    body: {
      name: 'Actual Teacher',
      email: TEST_TEACHER_EMAIL,
      password: TEST_TEACHER_PASSWORD,
    },
  })
  const login = await apiJson(baseUrl, '/api/edu/auth/login', {
    method: 'POST',
    body: {
      provider: 'password',
      email: TEST_TEACHER_EMAIL,
      password: TEST_TEACHER_PASSWORD,
    },
  })
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0] || ''
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase()
  const classroom = await apiJson(baseUrl, '/api/edu/classrooms', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: {
      name: `Tandem Test ${suffix}`,
      teacher_name: 'Ms. Keating',
      join_code: `TT${suffix.slice(0, 4)}`,
    },
  })
  const assignment = await apiJson(baseUrl, '/api/edu/assignments', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: {
      title: `Live tandem draft ${suffix}`,
      course: 'English',
      classroom_id: classroom.body.id,
      classroom_name: classroom.body.name,
      prompt: 'Draft a claim and add one piece of evidence.',
      ...assignmentOverrides,
    },
  })

  return {
    cookie,
    classroom: classroom.body,
    assignment: assignment.body,
  }
}

async function publishStudentDraft(baseUrl, workspace, text, liveSessionId, studentName = 'Ada Lovelace') {
  const activityAt = new Date().toISOString()
  const result = await apiJson(baseUrl, '/api/edu/live-sessions', {
    method: 'POST',
    body: {
      id: liveSessionId,
      assignment_id: workspace.assignment.id,
      assignment_title: workspace.assignment.title,
      course: workspace.assignment.course,
      classroom: workspace.classroom.name,
      student_name: studentName,
      current_text: text,
      document_history: [{ op: 'insert', text, ts_ms: Date.now() }],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: activityAt,
      schedule_open: true,
      focused: true,
      hid_active: true,
    },
  })
  return result.body
}

function liveSessionIdForStudent(studentName, assignmentId) {
  return `${studentName}:${assignmentId}`
}

async function publishStudentDraftWithRealTauriIpc(baseUrl, workspace, text, studentName = 'Ada Lovelace') {
  const now = Date.now()
  const activityAt = new Date(now).toISOString()
  const request = {
    api_origin: baseUrl,
    session: {
      id: liveSessionIdForStudent(studentName, workspace.assignment.id),
      assignment_id: workspace.assignment.id,
      assignment_title: workspace.assignment.title,
      course: workspace.assignment.course,
      classroom: workspace.classroom.name,
      student_name: studentName,
      current_text: text,
      document_history: [{ t: now, pos: 0, del: '', ins: text }],
      document_history_tail: [{ t: now, pos: 0, del: '', ins: text }],
      history_base_count: 0,
      history_base_t: 0,
      current_text_checkpoint: text,
      keystroke_log: '',
      focus_events: [],
      current_url: null,
      current_url_title: null,
      url_history: [],
      violation_count: 0,
      violations: [],
      last_activity_at: activityAt,
      schedule_open: true,
      focused: true,
      hid_active: true,
      capture_replay: false,
      replay_session_id: null,
      updated_at: activityAt,
    },
  }

  const studentRoot = path.resolve(process.cwd(), '..', '..', 'handtyped-edu')
  const builtPublisher = path.join(studentRoot, 'target', 'debug', 'student-ipc-publish')
  const [command, args] = fs.existsSync(builtPublisher)
    ? [builtPublisher, []]
    : ['cargo', ['run', '--quiet', '--bin', 'student-ipc-publish']]
  const child = spawn(command, args, {
    cwd: studentRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdin.end(JSON.stringify(request))

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0) {
    throw new Error(`real Tauri IPC student publish failed with ${code}: ${stderr || stdout}`)
  }
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`real Tauri IPC student publish returned invalid JSON: ${error.message}\n${stdout}\n${stderr}`)
  }
}

function installMinimalRichTextCommands(window, editor) {
  const commandState = new Map()

  function selectedText() {
    const selection = window.getSelection()
    return selection?.toString?.() || editor.textContent || ''
  }

  function replaceSelectionWithHtml(html) {
    editor.innerHTML = html
    const range = window.document.createRange()
    range.selectNodeContents(editor)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }

  window.document.execCommand = (command) => {
    const normalized = String(command || '').toLowerCase()
    const text = selectedText()
    if (normalized === 'bold') {
      const next = !commandState.get('bold')
      commandState.set('bold', next)
      replaceSelectionWithHtml(next ? `<b>${text}</b>` : text)
      return true
    }
    if (normalized === 'italic') {
      const next = !commandState.get('italic')
      commandState.set('italic', next)
      replaceSelectionWithHtml(next ? `<i>${text}</i>` : text)
      return true
    }
    if (normalized === 'underline') {
      const next = !commandState.get('underline')
      commandState.set('underline', next)
      replaceSelectionWithHtml(next ? `<u>${text}</u>` : text)
      return true
    }
    return false
  }

  window.document.queryCommandState = (command) => Boolean(commandState.get(String(command || '').toLowerCase()))
}

function loadTeacherAppInDom({ fetchImpl } = {}) {
  const root = process.cwd()
  const html = fs
    .readFileSync(path.join(root, 'public', 'edu', 'app.html'), 'utf8')
    .replace(/<script type="module" src="\/edu\/app\.js"><\/script>/, '')
  const source = stripBootstrapping(fs.readFileSync(path.join(root, 'public', 'edu', 'app.js'), 'utf8'))
  const window = new Window({ url: 'https://edu.handtyped.app/app' })
  window.document.write(html)
  window.document.close()
  window.alert = () => {}
  window.confirm = () => true
  window.EventSource = function EventSource() {
    return { addEventListener() {}, close() {} }
  }

  const previousGlobals = {
    Node: globalThis.Node,
    Element: globalThis.Element,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    FormData: globalThis.FormData,
    CSS: globalThis.CSS,
  }
  globalThis.Node = window.Node
  globalThis.Element = window.Element
  globalThis.HTMLSelectElement = window.HTMLSelectElement
  globalThis.HTMLInputElement = window.HTMLInputElement
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement
  globalThis.FormData = window.FormData
  globalThis.CSS = window.CSS

  const factory = new Function(
    'aggregateRecentEditActivity',
    'recentEditActivity',
    'recentEditActivityCurve',
    'assignmentIsOpenNow',
    'assignmentViewMeta',
    'buildAfterSchoolRanges',
    'dashboardDeltaNeedsFullRefresh',
    'deriveSessionRisk',
    'focusLossSummary',
    'formatClockTime',
    'formatWindowSummary',
    'isSessionActive',
    'localDateTimeInputValue',
    'nextLocalTimeAtOrAfter',
    'reconcileTeacherNavigation',
    'replayLocalDateInputValue',
    'sessionPresenceTimestamp',
    'sessionStatusLabel',
    'sessionsForAssignment',
    'sortSessionsForDisplay',
    'studentRejoinHistorySummary',
    'timeAgoLabel',
    'todayAtLocalTime',
    'todayAtLocalTimeIso',
    'wholeClassExtensionLabel',
    'reviewDraftRenderMode',
    'reviewDraftRenderSignature',
    'buildAttributedDocument',
    'latestTextFromHistory',
    'document',
    'window',
    'fetch',
    'EventSource',
    'URL',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    `${source}
    return {
      wireModalButtons,
      wireForms,
      loadApp,
      selectReviewSession,
      setStarterDocumentMarkdown,
      syncStarterDocumentField,
      updateStarterDocumentToolbarState,
      document,
      window,
    }`,
  )

  const app = factory(
    () => ({ totalEdits: 0, activeStudents: 0, buckets: [0] }),
    () => ({ totalEdits: 0, buckets: [0] }),
    () => ({ totalEdits: 0, points: [0] }),
    () => true,
    () => '',
    () => [],
    () => false,
    () => ({ active: true, needsAttention: false, score: 0 }),
    focusLossSummary,
    (hour = 0, minute = 0) => `${hour}:${minute}`,
    () => '',
    () => true,
    () => '',
    () => new Date(),
    ({ classrooms, assignments, selectedClassroomId, selectedAssignmentId, currentView }) => ({
      classrooms,
      assignments,
      selectedClassroomId,
      selectedAssignmentId,
      currentView,
    }),
    () => '',
    () => Date.now(),
    () => 'Focused',
    (sessions, _classroomName, assignmentId) => (sessions || []).filter((session) => session.assignment_id === assignmentId),
    (sessions) => sessions || [],
    studentRejoinHistorySummary,
    () => 'just now',
    () => new Date(),
    () => new Date().toISOString(),
    () => '',
    reviewDraftRenderMode,
    reviewDraftRenderSignature,
    () => {},
    () => '',
    window.document,
    window,
    fetchImpl || (async () => createJsonResponse({})),
    window.EventSource,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    (callback) => {
      callback()
      return 0
    },
    () => {},
  )

  return {
    ...app,
    cleanup() {
      globalThis.Node = previousGlobals.Node
      globalThis.Element = previousGlobals.Element
      globalThis.HTMLSelectElement = previousGlobals.HTMLSelectElement
      globalThis.HTMLInputElement = previousGlobals.HTMLInputElement
      globalThis.HTMLTextAreaElement = previousGlobals.HTMLTextAreaElement
      globalThis.FormData = previousGlobals.FormData
      globalThis.CSS = previousGlobals.CSS
      window.close()
    },
  }
}

describe('teacher app interactions', () => {
  it('visibly toggles starter document formatting and stores the formatted markdown', () => {
    const app = loadTeacherAppInDom()
    try {
      const { document, window } = app
      const editor = document.getElementById('starter-document-editor')
      const boldButton = document.querySelector('[data-starter-command="bold"]')

      installMinimalRichTextCommands(window, editor)
      app.wireModalButtons()
      app.wireForms()
      app.setStarterDocumentMarkdown('Draft this claim')

      const range = document.createRange()
      range.selectNodeContents(editor)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)

      boldButton.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      boldButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

      expect(boldButton.getAttribute('aria-pressed')).toBe('true')
      expect(editor.innerHTML).toContain('<b>Draft this claim</b>')
      expect(document.getElementById('starter-document-field').value).toBe('**Draft this claim**')
    } finally {
      app.cleanup()
    }
  })

  it('submits the classroom name before disabling the creation form', async () => {
    const requests = []
    const app = loadTeacherAppInDom({
      fetchImpl: async (input, options = {}) => {
        requests.push({
          input: String(input),
          body: options.body ? JSON.parse(options.body) : null,
        })
        return createJsonResponse({ id: 'class-submitted', name: 'Creative Writing', join_code: 'CW101' }, { status: 201 })
      },
    })
    try {
      app.wireForms()
      app.document.querySelector('#classroom-form [name="name"]').value = 'Creative Writing'
      app.document.querySelector('#classroom-form [name="join_code"]').value = 'CW101'

      app.document.getElementById('classroom-form')
        .dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }))

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(requests).toContainEqual({
        input: '/api/edu/classrooms',
        body: {
          name: 'Creative Writing',
          teacher_name: 'Teacher',
          join_code: 'CW101',
        },
      })
    } finally {
      app.cleanup()
    }
  })

  it('prefills native assignment window time inputs when editing an existing assignment', async () => {
    const server = await startEduTestServer()
    let app
    try {
      const workspace = await createTeacherWorkspace(server.baseUrl, {
        windows: [
          {
            label: 'Teacher writing window',
            days: {
              monday: true,
              tuesday: true,
              wednesday: true,
              thursday: true,
              friday: true,
              saturday: false,
              sunday: false,
            },
            start_hour: 14,
            start_minute: 30,
            end_hour: 16,
            end_minute: 5,
          },
        ],
      })

      app = loadTeacherAppInDom({
        fetchImpl: teacherFetch(server.baseUrl, workspace.cookie),
      })
      await app.loadApp()

      app.document.querySelector(`[data-classroom-id="${workspace.classroom.id}"]`)
        .dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }))
      app.document.querySelector(`[data-assignment-id="${workspace.assignment.id}"]`)
        .dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }))
      app.document.getElementById('edit-assignment-button')
        .dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }))

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(app.document.querySelector('[name="window_start_time"]').value).toBe('14:30')
      expect(app.document.querySelector('[name="window_end_time"]').value).toBe('16:05')
    } finally {
      app?.cleanup()
      await server.close()
    }
  })

  it('shows student draft updates in the teacher review surface from the same server', async () => {
    const server = await startEduTestServer()
    let app
    try {
      const workspace = await createTeacherWorkspace(server.baseUrl)
      const liveSessionId = `tandem:${workspace.assignment.id}:ada`
      const firstDraft = 'My claim is that handwritten drafting helps me think.'
      const secondDraft = `${firstDraft}\n\nEvidence: I revised each sentence after rereading it.`

      await publishStudentDraft(server.baseUrl, workspace, firstDraft, liveSessionId)

      app = loadTeacherAppInDom({
        fetchImpl: teacherFetch(server.baseUrl, workspace.cookie),
      })
      await app.loadApp()

      const classroomButton = app.document.querySelector(`[data-classroom-id="${workspace.classroom.id}"]`)
      classroomButton.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }))
      const assignmentButton = app.document.querySelector(`[data-assignment-id="${workspace.assignment.id}"]`)
      assignmentButton.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }))

      expect(app.document.getElementById('session-grid').textContent).toContain('Ada Lovelace')

      await app.selectReviewSession(liveSessionId)
      expect(app.document.getElementById('review-workspace-title').textContent).toBe('Ada Lovelace')
      expect(app.document.getElementById('review-draft-surface').textContent).toContain(firstDraft)
      expect(app.document.getElementById('review-draft-meta').textContent).toContain('9 words')

      await publishStudentDraft(server.baseUrl, workspace, secondDraft, liveSessionId)
      await app.selectReviewSession(liveSessionId)

      expect(app.document.getElementById('review-draft-surface').textContent).toContain(
        'Evidence: I revised each sentence after rereading it.',
      )
      expect(app.document.getElementById('review-draft-meta').textContent).toContain('Live draft is')
      expect(app.document.getElementById('review-draft-meta').textContent).toContain('17 words')
    } finally {
      app?.cleanup()
      await server.close()
    }
  })

  it('navigates between students while grading and exports PDF feedback without handtyped tab markers', async () => {
    const server = await startEduTestServer()
    let app
    try {
      const workspace = await createTeacherWorkspace(server.baseUrl, {
        rubric: [
          { id: 'claim', title: 'Claim', description: 'Clear central idea', points: 4 },
          { id: 'evidence', title: 'Evidence', description: 'Uses relevant support', points: 6 },
        ],
      })
      const adaSessionId = `tandem:${workspace.assignment.id}:ada`
      const graceSessionId = `tandem:${workspace.assignment.id}:grace`
      const adaDraft = 'Claim[handtyped-tab][/handtyped-tab]with a tab marker.'
      const graceDraft = 'Grace wrote the next response.'
      let exportedHtml = ''
      let printed = false

      await publishStudentDraft(server.baseUrl, workspace, adaDraft, adaSessionId, 'Ada Lovelace')
      await publishStudentDraft(server.baseUrl, workspace, graceDraft, graceSessionId, 'Grace Hopper')
      await apiJson(server.baseUrl, `/api/edu/live-sessions/${adaSessionId}/grading`, {
        method: 'PUT',
        headers: { Cookie: workspace.cookie },
        body: {
          publish_feedback: false,
          teacher_comment: '',
          inline_annotations: [
            {
              id: 'annotation-claim',
              type: 'comment',
              start: 0,
              end: 5,
              quote: 'Claim',
              note: 'This is the claim feedback.',
              context_before: '',
              context_after: ' with a tab marker.',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              resolved_by_student: false,
            },
          ],
          grade_label: 'A-',
          grade_score: 92,
        },
      })

      app = loadTeacherAppInDom({
        fetchImpl: teacherFetch(server.baseUrl, workspace.cookie),
      })
      app.window.open = () => ({
        document: {
          open() {},
          write(html) {
            exportedHtml += html
          },
          close() {},
        },
        focus() {},
        print() {
          printed = true
        },
      })
      await app.loadApp()

      app.document
        .querySelector(`[data-classroom-id="${workspace.classroom.id}"]`)
        .dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }))
      app.document
        .querySelector(`[data-assignment-id="${workspace.assignment.id}"]`)
        .dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }))

      await app.selectReviewSession(adaSessionId)
      expect(app.document.getElementById('review-workspace-title').textContent).toBe('Ada Lovelace')
      expect(app.document.getElementById('review-draft-surface').textContent).toContain('Claim\twith a tab marker.')
      expect(app.document.getElementById('review-draft-surface').textContent).not.toContain('handtyped-tab')
      expect(app.document.getElementById('review-draft-meta').textContent).toContain('5 words')
      expect(app.document.getElementById('session-grid').textContent).toContain('Grade A- / 92')

      const nextButton = app.document.getElementById('review-next-student')
      const previousButton = app.document.getElementById('review-previous-student')
      const awayButton = nextButton.disabled ? previousButton : nextButton
      const returnButton = nextButton.disabled ? nextButton : previousButton

      expect(awayButton.disabled).toBe(false)
      awayButton.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(app.document.getElementById('review-workspace-title').textContent).toBe('Grace Hopper')

      expect(returnButton.disabled).toBe(false)
      returnButton.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(app.document.getElementById('review-workspace-title').textContent).toBe('Ada Lovelace')

      const comment = app.document.getElementById('review-teacher-comment')
      comment.value = 'Nice claim; expand the evidence.'
      comment.dispatchEvent(new app.window.Event('input', { bubbles: true }))
      const claimScore = app.document.querySelector('[data-review-rubric-score="claim"]')
      const evidenceScore = app.document.querySelector('[data-review-rubric-score="evidence"]')
      claimScore.value = '3'
      claimScore.dispatchEvent(new app.window.Event('change', { bubbles: true }))
      evidenceScore.value = '5'
      evidenceScore.dispatchEvent(new app.window.Event('change', { bubbles: true }))
      app.document.getElementById('review-export-pdf')
        .dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(printed).toBe(true)
      expect(exportedHtml).toContain('Ada Lovelace')
      expect(exportedHtml).toContain('review-export-layout')
      expect(exportedHtml).toContain('inline-comment')
      expect(exportedHtml).not.toContain('margin-comment')
      expect(exportedHtml).toContain('comment-highlight')
      expect(exportedHtml).toContain('<span class="comment-highlight">Claim</span>')
      expect(exportedHtml).not.toContain('<blockquote>Claim</blockquote>')
      expect(exportedHtml).toContain('border-bottom: 2px solid #ca8a04')
      expect(exportedHtml).toContain('print-color-adjust: exact')
      expect(exportedHtml).toContain('This is the claim feedback.')
      expect(exportedHtml).toContain('Teacher Overall Feedback')
      expect(exportedHtml).toContain('Rubric Score')
      expect(exportedHtml).toContain('3/4')
      expect(exportedHtml).toContain('5/6')
      expect(exportedHtml).toContain('8/10')
      expect(exportedHtml).toContain('\twith a tab marker.')
      expect(exportedHtml).toContain('Nice claim; expand the evidence.')
      expect(exportedHtml).not.toContain('handtyped-tab')
    } finally {
      app?.cleanup()
      await server.close()
    }
  })

  it('publishes a student draft through real Tauri IPC into the teacher review surface', async () => {
    const server = await startEduTestServer()
    let teacherApp
    try {
      const workspace = await createTeacherWorkspace(server.baseUrl)
      const draft = 'Student text should cross the real Tauri IPC live sync path.'

      const ack = await publishStudentDraftWithRealTauriIpc(server.baseUrl, workspace, draft)
      expect(ack.accepted_history_count).toBeGreaterThan(0)

      teacherApp = loadTeacherAppInDom({
        fetchImpl: teacherFetch(server.baseUrl, workspace.cookie),
      })
      await teacherApp.loadApp()

      teacherApp.document
        .querySelector(`[data-classroom-id="${workspace.classroom.id}"]`)
        .dispatchEvent(new teacherApp.window.MouseEvent('click', { bubbles: true }))
      teacherApp.document
        .querySelector(`[data-assignment-id="${workspace.assignment.id}"]`)
        .dispatchEvent(new teacherApp.window.MouseEvent('click', { bubbles: true }))

      await teacherApp.selectReviewSession(liveSessionIdForStudent('Ada Lovelace', workspace.assignment.id))

      expect(teacherApp.document.getElementById('review-workspace-title').textContent).toBe('Ada Lovelace')
      expect(teacherApp.document.getElementById('review-draft-surface').textContent).toContain(draft)
    } finally {
      teacherApp?.cleanup()
      await server.close()
    }
  }, 30000)
})
