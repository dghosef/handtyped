import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Window } from 'happy-dom'
import { createApp } from './server-lib.js'

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

async function createTeacherWorkspace(baseUrl) {
  const login = await apiJson(baseUrl, '/api/edu/auth/login', {
    method: 'POST',
    body: {
      provider: 'password',
      email: 'teacher@edu.handtyped.app',
      password: 'handtyped-edu',
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
    },
  })

  return {
    cookie,
    classroom: classroom.body,
    assignment: assignment.body,
  }
}

async function publishStudentDraft(baseUrl, workspace, text, liveSessionId) {
  const activityAt = new Date().toISOString()
  const result = await apiJson(baseUrl, '/api/edu/live-sessions', {
    method: 'POST',
    body: {
      id: liveSessionId,
      assignment_id: workspace.assignment.id,
      assignment_title: workspace.assignment.title,
      course: workspace.assignment.course,
      classroom: workspace.classroom.name,
      student_name: 'Ada Lovelace',
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
    'timeAgoLabel',
    'todayAtLocalTime',
    'todayAtLocalTimeIso',
    'wholeClassExtensionLabel',
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
    () => 'just now',
    () => new Date(),
    () => new Date().toISOString(),
    () => '',
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

      await publishStudentDraft(server.baseUrl, workspace, secondDraft, liveSessionId)
      await app.selectReviewSession(liveSessionId)

      expect(app.document.getElementById('review-draft-surface').textContent).toContain(
        'Evidence: I revised each sentence after rereading it.',
      )
      expect(app.document.getElementById('review-draft-meta').textContent).toContain('Live draft is')
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
