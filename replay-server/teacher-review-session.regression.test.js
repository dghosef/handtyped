import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

function createStubElement() {
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    value: '',
    checked: false,
    dataset: {},
    style: { setProperty() {} },
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    focus() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    matches() { return false },
  }
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

function loadTeacherAppHarness({ fetchImpl } = {}) {
  const appPath = path.join(process.cwd(), 'public', 'edu', 'app.js')
  let source = fs.readFileSync(appPath, 'utf8')
  source = source
    .replace(/import\s*\{[\s\S]*?\}\s*from '\.\/app-ui\.js'\s*/m, '')
    .replace(/import\s*\{[\s\S]*?\}\s*from '\.\.\/replay-view\.js'\s*/m, '')
    .replace(/loadApp\(\)\.catch\(\(error\) => \{[\s\S]*?\}\)\s*$/m, '')

  const factory = new Function(
    'aggregateRecentEditActivity',
    'assignmentIsOpenNow',
    'assignmentViewMeta',
    'buildAfterSchoolRanges',
    'dashboardDeltaNeedsFullRefresh',
    'deriveSessionRisk',
    'formatWindowSummary',
    'isSessionActive',
    'localDateTimeInputValue',
    'nextLocalTimeAtOrAfter',
    'reconcileTeacherNavigation',
    'replayLocalDateInputValue',
    'sessionStatusLabel',
    'sessionsForAssignment',
    'sortSessionsForDisplay',
    'timeAgoLabel',
    'todayAtLocalTime',
    'todayAtLocalTimeIso',
    'buildAttributedDocument',
    'latestTextFromHistory',
    'document',
    'window',
    'fetch',
    'EventSource',
    'URL',
    'Node',
    'FormData',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    `${source}
    return {
      handleRealtimeDashboard,
      handleRealtimeAssignment,
      handleRealtimeReplay,
      beginReviewComposer,
      addReviewAnnotation,
      saveCurrentReview,
      flushReviewSave,
      selectReviewSession,
      renderReviewWorkspace,
      refreshAssignmentViewData,
      refreshSelectedReviewSessionData,
      refreshSelectedReviewReplayData,
      renderDashboard,
      renderStudentCards,
      getElement(id) { return document.getElementById(id) },
      setDashboardState(value) { dashboardState = value },
      getDashboardState() { return dashboardState },
      setReviewSelection(value) {
        selectedAssignmentId = value.selectedAssignmentId
        selectedReviewSessionId = value.selectedReviewSessionId
        selectedClassroomId = value.selectedClassroomId || null
        reviewWorkspaceOpen = value.reviewWorkspaceOpen
        currentView = value.currentView || currentView
        selectedReviewSessionSnapshot =
          value.selectedReviewSessionSnapshot ||
          dashboardState?.live_sessions?.find((session) => session.id === selectedReviewSessionId) ||
          null
      },
      getReviewSelection() {
        return {
          currentView,
          selectedAssignmentId,
          selectedReviewSessionId,
          selectedReviewSessionSnapshot,
          selectedClassroomId,
          reviewWorkspaceOpen,
        }
      },
      setReviewState(value) { reviewState = value },
      getReviewState() { return reviewState },
      setActiveElement(value) { document.activeElement = value },
      setPendingStudentAccessAction(studentName, action) {
        pendingStudentAccessActions.set(studentName, action)
      },
      clearPendingStudentAccessAction(studentName) {
        pendingStudentAccessActions.delete(studentName)
      },
      setRefreshAssignmentViewData(value) { refreshAssignmentViewData = value },
      setRefreshSelectedReviewReplayData(value) { refreshSelectedReviewReplayData = value },
      stubRenderStudentCards() { renderStudentCards = () => {} },
    }`,
  )

  const elementMap = new Map()
  function getStub(key) {
    if (!elementMap.has(key)) {
      elementMap.set(key, createStubElement())
    }
    return elementMap.get(key)
  }

  const documentStub = {
    hidden: false,
    body: { dataset: {}, innerHTML: '' },
    getElementById(id) { return getStub(`id:${id}`) },
    querySelector(selector) { return getStub(`selector:${selector}`) },
    querySelectorAll() { return [] },
    addEventListener() {},
    createElement() { return createStubElement() },
  }
  const windowStub = {
    location: { href: '', origin: 'https://edu.handtyped.app' },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    alert() {},
    confirm() { return true },
  }
  const noop = () => {}
  const eventSourceStub = function EventSource() {
    return { addEventListener() {}, close() {} }
  }

  return factory(
    () => ({ totalEdits: 0, activeStudents: 0, buckets: [0] }),
    () => true,
    () => '',
    () => [],
    () => false,
    () => ({ active: true, needsAttention: false, score: 0 }),
    () => '',
    (session, now = Date.now()) => {
      if (!session?.schedule_open) {
        return false
      }
      const parsed = Date.parse(String(session.last_activity_at || session.updated_at || ''))
      return Number.isFinite(parsed) && now - parsed <= 6000
    },
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
    () => 'Focused',
    (sessions, _classroomName, assignmentId) => (sessions || []).filter((session) => session.assignment_id === assignmentId),
    (sessions) => sessions || [],
    () => 'just now',
    () => new Date(),
    () => new Date().toISOString(),
    noop,
    () => '',
    documentStub,
    windowStub,
    fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    eventSourceStub,
    URL,
    { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    FormData,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  )
}

describe('teacher review session regression', () => {
  it('keeps the selected review draft session when assignment realtime summaries omit it', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
    })
    harness.stubRenderStudentCards()

    harness.handleRealtimeAssignment({
      assignment: { id: 'assignment-1' },
      live_sessions: [
        {
          id: 'live-other',
          assignment_id: 'assignment-1',
          student_name: 'Grace Hopper',
          current_text: 'Other draft',
          schedule_open: true,
          focused: true,
          last_activity_at: '2026-04-29T20:00:01.000Z',
        },
      ],
      assignment_audits: [],
    })

    expect(harness.getDashboardState().live_sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(['live-selected', 'live-other']),
    )
  })

  it('rerenders the open review workspace immediately when the selected student gets a live assignment update', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Before live update',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
      selectedReviewSessionSnapshot: selectedSession,
    })
    harness.setReviewState({
      sessionId: 'live-selected',
      replayData: null,
      replayLoadState: 'idle',
      replayError: '',
      inlineAnnotations: [],
      rubricScores: {},
      gradeLabel: '',
      gradeScore: '',
      teacherComment: '',
      returnedForRevision: false,
      updatedBy: '',
      selection: null,
    })
    harness.stubRenderStudentCards()

    harness.handleRealtimeAssignment({
      assignment: { id: 'assignment-1' },
      live_sessions: [
        {
          id: 'live-selected',
          assignment_id: 'assignment-1',
          student_name: 'Ada Lovelace',
          current_text: 'After live update',
          schedule_open: true,
          focused: true,
          last_activity_at: '2026-04-29T20:00:01.000Z',
        },
      ],
      assignment_audits: [],
    })

    expect(harness.getReviewSelection().selectedReviewSessionSnapshot.current_text).toBe('After live update')
    expect(harness.getElement('review-draft-meta').textContent).toContain('17 characters')
  })

  it('preserves existing assignment audits when live assignment updates omit audit payloads', () => {
    const harness = loadTeacherAppHarness()
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [],
      assignment_audits: [
        { id: 'audit-1', assignment_id: 'assignment-1', summary: 'Created assignment' },
        { id: 'audit-2', assignment_id: 'assignment-1', summary: 'Teacher updated prompt' },
      ],
      summary: {},
    })
    harness.stubRenderStudentCards()

    harness.handleRealtimeAssignment({
      assignment: { id: 'assignment-1' },
      live_sessions: [
        {
          id: 'live-selected',
          assignment_id: 'assignment-1',
          student_name: 'Ada Lovelace',
          current_text: 'Live draft text',
          schedule_open: true,
          focused: true,
          last_activity_at: '2026-04-29T20:00:01.000Z',
        },
      ],
    })

    expect(harness.getDashboardState().assignment_audits).toEqual([
      { id: 'audit-1', assignment_id: 'assignment-1', summary: 'Created assignment' },
      { id: 'audit-2', assignment_id: 'assignment-1', summary: 'Teacher updated prompt' },
    ])
  })

  it('keeps live draft text updating even while the teacher is focused in the review form', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Original draft',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
      selectedReviewSessionSnapshot: selectedSession,
    })
    harness.setReviewState({
      sessionId: 'live-selected',
      replayData: null,
      replayLoadState: 'idle',
      replayError: '',
      inlineAnnotations: [],
      rubricScores: {},
      gradeLabel: '',
      gradeScore: '',
      teacherComment: 'Keep going',
      returnedForRevision: false,
      updatedBy: '',
      selection: null,
      updatedAt: '2026-04-29T20:00:00.000Z',
    })
    harness.renderReviewWorkspace({ id: 'assignment-1', title: 'Essay 1' })
    const activeEditor = createStubElement()
    activeEditor.closest = () => ({})
    activeEditor.matches = (selector) => selector === 'textarea, input, select'
    harness.setActiveElement(activeEditor)

    harness.handleRealtimeDashboard({
      updated_at: '2026-04-29T20:00:05.000Z',
      live_sessions: [
        {
          ...selectedSession,
          current_text: 'Live draft while teacher types',
          last_activity_at: '2026-04-29T20:00:05.000Z',
        },
      ],
      assignment_audits: [],
    })

    expect(harness.getElement('review-draft-meta').textContent).toContain('30 characters')
    expect(harness.getReviewState().teacherComment).toBe('Keep going')
  })

  it('keeps live draft text updating on assignment realtime without clobbering the teacher comment field', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Original draft',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
      selectedReviewSessionSnapshot: selectedSession,
    })
    harness.setReviewState({
      sessionId: 'live-selected',
      replayData: null,
      replayLoadState: 'idle',
      replayError: '',
      inlineAnnotations: [],
      rubricScores: {},
      gradeLabel: '',
      gradeScore: '',
      teacherComment: 'Keep this note',
      returnedForRevision: false,
      updatedBy: '',
      selection: null,
      updatedAt: '2026-04-29T20:00:00.000Z',
    })
    harness.renderReviewWorkspace({ id: 'assignment-1', title: 'Essay 1' })
    const activeEditor = createStubElement()
    activeEditor.closest = () => ({})
    activeEditor.matches = (selector) => selector === 'textarea, input, select'
    harness.setActiveElement(activeEditor)
    harness.getElement('review-teacher-comment').value = 'Keep typing here'

    harness.handleRealtimeAssignment({
      assignment: { id: 'assignment-1' },
      live_sessions: [
        {
          ...selectedSession,
          current_text: 'Live draft from assignment realtime',
          last_activity_at: '2026-04-29T20:00:05.000Z',
        },
      ],
    })

    expect(harness.getElement('review-draft-meta').textContent).toContain('35 characters')
    expect(harness.getElement('review-teacher-comment').value).toBe('Keep typing here')
    expect(harness.getReviewState().teacherComment).toBe('Keep this note')
  })

  it('keeps the selected review draft session across a full dashboard realtime payload that omits it', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
    })
    harness.stubRenderStudentCards()

    harness.handleRealtimeDashboard({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [],
      assignment_audits: [],
      summary: {
        classrooms: 1,
        assignments: 1,
        live_sessions: 1,
        audits_recorded: 0,
      },
    })

    expect(harness.getDashboardState().live_sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(['live-selected']),
    )
  })

  it('still refreshes the student grid while the teacher is focused in the review form', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      current_url: 'https://original.example/essay',
      url_history: [{ url: 'https://original.example/essay', allowed: true }],
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      currentView: 'assignment',
      selectedClassroomId: 'class-1',
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      selectedReviewSessionSnapshot: selectedSession,
    })
    harness.setReviewState({
      sessionId: 'live-selected',
      replayData: null,
      replayLoadState: 'idle',
      replayError: '',
      inlineAnnotations: [],
      rubricScores: {},
      gradeLabel: '',
      gradeScore: '',
      teacherComment: 'Hold steady',
      returnedForRevision: false,
      updatedBy: '',
      selection: null,
      updatedAt: '2026-04-29T20:00:00.000Z',
    })
    harness.renderReviewWorkspace({ id: 'assignment-1', title: 'Essay 1' })
    const activeEditor = createStubElement()
    activeEditor.closest = () => ({})
    activeEditor.matches = (selector) => selector === 'textarea, input, select'
    harness.setActiveElement(activeEditor)

    harness.handleRealtimeDashboard({
      updated_at: '2026-04-29T20:00:05.000Z',
      live_sessions: [
        {
          ...selectedSession,
          current_url: 'https://updated.example/source',
          url_history: [{ url: 'https://updated.example/source', allowed: true }],
          last_activity_at: '2026-04-29T20:00:05.000Z',
        },
      ],
      assignment_audits: [],
      summary: {
        live_sessions: 1,
        active_students: 1,
      },
    })

    expect(harness.getElement('session-grid').innerHTML).toContain('https://updated.example/source')
    expect(harness.getElement('review-teacher-comment').value).toBe('Hold steady')
  })

  it('keeps the selected review draft session across a full dashboard render refresh that omits it', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      currentView: 'assignment',
      selectedClassroomId: 'class-1',
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
    })

    harness.renderDashboard({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [],
      assignment_audits: [],
      summary: {
        classrooms: 1,
        assignments: 1,
        live_sessions: 0,
        audits_recorded: 0,
      },
    })

    expect(harness.getDashboardState().live_sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(['live-selected']),
    )
    expect(harness.getReviewSelection().selectedReviewSessionId).toBe('live-selected')
    expect(harness.getReviewSelection().reviewWorkspaceOpen).toBe(true)
  })

  it('keeps the selected review draft open when summaries still include it but the direct live-session refresh returns not found', async () => {
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    const harness = loadTeacherAppHarness({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/edu/assignments/assignment-1')) {
          return createJsonResponse({ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' })
        }
        if (url.endsWith('/api/edu/assignments/assignment-1/live-summaries')) {
          return createJsonResponse({
            assignment_id: 'assignment-1',
            live_sessions: [selectedSession],
            updated_at: '2026-04-29T20:00:01.000Z',
          })
        }
        if (url.endsWith('/api/edu/assignments/assignment-1/audit')) {
          return createJsonResponse([])
        }
        if (url.endsWith('/api/edu/live-sessions/live-selected')) {
          return createJsonResponse({ error: 'Not found' }, { ok: false, status: 404 })
        }
        return createJsonResponse({})
      },
    })
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      currentView: 'assignment',
      selectedClassroomId: 'class-1',
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
    })
    harness.stubRenderStudentCards()

    await harness.refreshAssignmentViewData()

    expect(harness.getReviewSelection().selectedReviewSessionId).toBe('live-selected')
    expect(harness.getReviewSelection().reviewWorkspaceOpen).toBe(true)
    expect(harness.getDashboardState().live_sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(['live-selected']),
    )
  })

  it('keeps the selected review draft open from its pinned snapshot when summaries omit it and the direct live-session refresh returns not found', async () => {
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: false,
      focused: false,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    const harness = loadTeacherAppHarness({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/edu/assignments/assignment-1')) {
          return createJsonResponse({
            id: 'assignment-1',
            classroom_id: 'class-1',
            title: 'Essay 1',
            student_access_revoked: { ada: true },
          })
        }
        if (url.endsWith('/api/edu/assignments/assignment-1/live-summaries')) {
          return createJsonResponse({
            assignment_id: 'assignment-1',
            live_sessions: [],
            updated_at: '2026-04-29T20:00:01.000Z',
          })
        }
        if (url.endsWith('/api/edu/assignments/assignment-1/audit')) {
          return createJsonResponse([])
        }
        if (url.endsWith('/api/edu/live-sessions/live-selected')) {
          return createJsonResponse({ error: 'Not found' }, { ok: false, status: 404 })
        }
        return createJsonResponse({})
      },
    })
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      currentView: 'assignment',
      selectedClassroomId: 'class-1',
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      selectedReviewSessionSnapshot: selectedSession,
    })
    harness.stubRenderStudentCards()

    await harness.refreshAssignmentViewData()

    expect(harness.getReviewSelection().selectedReviewSessionId).toBe('live-selected')
    expect(harness.getReviewSelection().reviewWorkspaceOpen).toBe(true)
    expect(harness.getReviewSelection().selectedReviewSessionSnapshot).toMatchObject({
      id: 'live-selected',
      student_name: 'Ada Lovelace',
    })
  })

  it('falls back to the stored replay when the live replay endpoint returns not found', async () => {
    const selectedSession = {
      id: 'live-selected',
      replay_session_id: 'replay-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: '',
      schedule_open: false,
      focused: false,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    const requests = []
    const harness = loadTeacherAppHarness({
      fetchImpl: async (input) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith('/api/edu/live-replays/live-selected')) {
          return createJsonResponse({ error: 'Not found' }, { ok: false, status: 404 })
        }
        if (url.endsWith('/api/edu/replays/replay-selected')) {
          return createJsonResponse({
            id: 'replay-selected',
            live_session_id: 'live-selected',
            assignment_id: 'assignment-1',
            student_name: 'Ada Lovelace',
            current_text: 'Recovered from stored replay',
            document_history: [{ t: 100, pos: 0, del: '', ins: 'Recovered from stored replay' }],
            url_history: [],
            recorded_timezone_offset_minutes: 0,
          })
        }
        return createJsonResponse({})
      },
    })
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
    })

    harness.renderReviewWorkspace({ id: 'assignment-1', title: 'Essay 1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requests).toContain('/api/edu/live-replays/live-selected')
    expect(requests).toContain('/api/edu/replays/replay-selected')
    expect(harness.getElement('review-highlight-meta').textContent).toContain('Pick a day')
    expect(harness.getElement('review-draft-meta').textContent).toContain('Live draft is 28 characters')
  })

  it('does not keep retrying replay highlight loads after a not found response', async () => {
    const selectedSession = {
      id: 'live-selected',
      replay_session_id: 'replay-missing',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: '',
      schedule_open: false,
      focused: false,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    let replayFetches = 0
    const harness = loadTeacherAppHarness({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/edu/live-replays/live-selected')) {
          replayFetches += 1
          return createJsonResponse({ error: 'Not found' }, { ok: false, status: 404 })
        }
        if (url.endsWith('/api/edu/replays/replay-missing')) {
          return createJsonResponse({ error: 'Not found' }, { ok: false, status: 404 })
        }
        return createJsonResponse({})
      },
    })
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
    })

    harness.renderReviewWorkspace({ id: 'assignment-1', title: 'Essay 1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.renderReviewWorkspace({ id: 'assignment-1', title: 'Essay 1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(replayFetches).toBe(1)
    expect(harness.getElement('review-highlight-meta').textContent).toContain('Replay data is no longer available')
  })

  it('updates the selected review draft session from replay realtime payloads', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Draft one',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
    })

    harness.handleRealtimeReplay({
      id: 'live-selected',
      current_text: 'Draft one revised live',
      last_activity_at: '2026-04-29T20:00:05.000Z',
      updated_at: '2026-04-29T20:00:05.000Z',
      document_history: [
        { t: 100, pos: 0, del: '', ins: 'Draft one' },
        { t: 250, pos: 9, del: '', ins: ' revised live' },
      ],
      url_history: [],
      events: [],
      last_seq: 2,
    })

    expect(
      harness.getDashboardState().live_sessions.find((session) => session.id === 'live-selected'),
    ).toMatchObject({
      current_text: 'Draft one revised live',
      last_activity_at: '2026-04-29T20:00:05.000Z',
    })
    expect(harness.getReviewSelection().selectedReviewSessionSnapshot).toMatchObject({
      id: 'live-selected',
      current_text: 'Draft one revised live',
      last_activity_at: '2026-04-29T20:00:05.000Z',
    })
  })

  it('shows active status in the focused review workspace meta', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Draft one',
      schedule_open: true,
      focused: true,
      last_activity_at: new Date().toISOString(),
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
    })

    harness.renderReviewWorkspace({ id: 'assignment-1', title: 'Essay 1' })

    expect(harness.getElement('review-workspace-meta').textContent).toContain('Active')
    expect(harness.getElement('review-activity-status').textContent).toBe('Active')
    expect(harness.getElement('review-activity-status').className).toContain('student-badge-good')
  })

  it('shows not active status in the focused review workspace meta for stale sessions', () => {
    const harness = loadTeacherAppHarness()
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Draft one',
      schedule_open: true,
      focused: false,
      last_activity_at: '2000-01-01T00:00:00.000Z',
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
    })

    harness.renderReviewWorkspace({ id: 'assignment-1', title: 'Essay 1' })

    expect(harness.getElement('review-workspace-meta').textContent).toContain('Not active')
    expect(harness.getElement('review-activity-status').textContent).toBe('Not active')
    expect(harness.getElement('review-activity-status').className).toContain('student-badge-danger')
  })

  it('hides the close access button when that student is already revoked', () => {
    const harness = loadTeacherAppHarness()
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
      student_access_revoked: {
        'ada lovelace': true,
      },
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [
        {
          id: 'live-selected',
          assignment_id: assignment.id,
          student_name: 'Ada Lovelace',
          current_text: 'Draft one',
          schedule_open: true,
          focused: true,
          last_activity_at: new Date().toISOString(),
        },
      ],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      reviewWorkspaceOpen: false,
      currentView: 'assignment',
    })

    harness.renderStudentCards()

    const sessionGridHtml = harness.getElement('session-grid').innerHTML
    expect(sessionGridHtml).not.toContain('data-close-student-access=')
    expect(sessionGridHtml).toContain('Extend this student')
  })

  it('turns off the special access badge after student-specific access expires', () => {
    const harness = loadTeacherAppHarness()
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
      student_temporary_access_until: {
        'ada lovelace': new Date(Date.now() - 60_000).toISOString(),
      },
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [
        {
          id: 'live-selected',
          assignment_id: assignment.id,
          student_name: 'Ada Lovelace',
          current_text: 'Draft one',
          schedule_open: false,
          focused: true,
          last_activity_at: new Date().toISOString(),
        },
      ],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      reviewWorkspaceOpen: false,
      currentView: 'assignment',
    })

    harness.renderStudentCards()

    expect(harness.getElement('session-grid').innerHTML).not.toContain('Special access')
  })

  it('keeps extend in an extending state instead of showing closing copy', () => {
    const harness = loadTeacherAppHarness()
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [
        {
          id: 'live-selected',
          assignment_id: assignment.id,
          student_name: 'Ada Lovelace',
          current_text: 'Draft one',
          schedule_open: true,
          focused: true,
          last_activity_at: new Date().toISOString(),
        },
      ],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      reviewWorkspaceOpen: false,
      currentView: 'assignment',
    })
    harness.setPendingStudentAccessAction('Ada Lovelace', 'extend')

    harness.renderStudentCards()

    const sessionGridHtml = harness.getElement('session-grid').innerHTML
    expect(sessionGridHtml).toContain('Extending…')
    expect(sessionGridHtml).not.toContain('Closing…')
  })

  it('allows inline comments to be added while the student is still actively editing', async () => {
    const savedPayloads = []
    const harness = loadTeacherAppHarness({
      fetchImpl: async (_url, options = {}) => {
        const payload = JSON.parse(String(options.body || '{}'))
        if (String(_url).includes('/grading')) {
          savedPayloads.push(payload)
        }
        return createJsonResponse({
          id: 'live-selected',
          grading: {
            ...payload,
            updated_at: '2026-05-02T17:00:00.000Z',
          },
        })
      },
    })
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
      policy: { allow_offline_editing: false },
    }
    const selectedSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: new Date().toISOString(),
      grading: { inline_annotations: [] },
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: selectedSession.id,
      reviewWorkspaceOpen: true,
      selectedReviewSessionSnapshot: selectedSession,
    })

    harness.renderReviewWorkspace(assignment)
    harness.setReviewState({
      ...harness.getReviewState(),
      selection: {
        start: 0,
        end: 8,
        text: 'Selected',
      },
    })

    harness.beginReviewComposer('comment')
    harness.getElement('review-composer-note').value = 'Open with a clearer claim.'
    await harness.addReviewAnnotation()

    expect(harness.getReviewState().inlineAnnotations).toEqual([
      expect.objectContaining({
        type: 'comment',
        start: 0,
        end: 8,
        quote: 'Selected',
        note: 'Open with a clearer claim.',
      }),
    ])
    expect(savedPayloads).toEqual([
      expect.objectContaining({
        inline_annotations: [
          expect.objectContaining({
            quote: 'Selected',
            note: 'Open with a clearer claim.',
          }),
        ],
      }),
    ])
  })

  it('saves a newly added inline comment after an older autosave finishes first', async () => {
    let resolveFirstSave
    const firstSave = new Promise((resolve) => {
      resolveFirstSave = resolve
    })
    const savedPayloads = []
    const harness = loadTeacherAppHarness({
      fetchImpl: async (_url, options = {}) => {
        const payload = JSON.parse(String(options.body || '{}'))
        if (!String(_url).includes('/grading')) {
          return createJsonResponse({})
        }
        savedPayloads.push(payload)
        if (savedPayloads.length === 1) {
          await firstSave
        }
        return createJsonResponse({
          id: 'live-selected',
          grading: {
            ...payload,
            updated_at: `2026-05-02T17:00:0${savedPayloads.length}.000Z`,
          },
        })
      },
    })
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
      policy: { allow_offline_editing: false },
    }
    const selectedSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: new Date().toISOString(),
      grading: { inline_annotations: [] },
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: selectedSession.id,
      reviewWorkspaceOpen: true,
      selectedReviewSessionSnapshot: selectedSession,
    })
    harness.renderReviewWorkspace(assignment)

    harness.setReviewState({
      ...harness.getReviewState(),
      dirty: true,
      saveState: 'saving',
    })
    const staleSave = harness.saveCurrentReview()
    await Promise.resolve()
    harness.setReviewState({
      ...harness.getReviewState(),
      selection: {
        start: 0,
        end: 8,
        text: 'Selected',
      },
    })
    harness.beginReviewComposer('comment')
    harness.getElement('review-composer-note').value = 'Open with a clearer claim.'
    const addComment = harness.addReviewAnnotation()
    resolveFirstSave()
    await staleSave
    await addComment

    expect(savedPayloads).toHaveLength(2)
    expect(savedPayloads[0].inline_annotations).toEqual([])
    expect(savedPayloads[1].inline_annotations).toEqual([
      expect.objectContaining({
        quote: 'Selected',
        note: 'Open with a clearer claim.',
      }),
    ])
  })

  it('shows retrying instead of failed while review feedback is still queued to sync', async () => {
    let saveAttempts = 0
    const harness = loadTeacherAppHarness({
      fetchImpl: async (url, options = {}) => {
        if (!String(url).includes('/grading')) {
          return createJsonResponse({})
        }
        saveAttempts += 1
        const payload = JSON.parse(String(options.body || '{}'))
        if (saveAttempts === 1) {
          return createJsonResponse({ error: 'Temporary outage' }, { ok: false, status: 503 })
        }
        return createJsonResponse({
          id: 'live-selected',
          grading: {
            ...payload,
            updated_at: '2026-05-02T17:00:02.000Z',
          },
        })
      },
    })
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
      policy: { allow_offline_editing: false },
    }
    const selectedSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: new Date().toISOString(),
      grading: { inline_annotations: [] },
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: selectedSession.id,
      reviewWorkspaceOpen: true,
      selectedReviewSessionSnapshot: selectedSession,
    })
    harness.stubRenderStudentCards()
    harness.renderReviewWorkspace(assignment)
    harness.setReviewState({
      ...harness.getReviewState(),
      dirty: true,
      saveState: 'saving',
      teacherComment: 'This needs one more pass.',
    })

    await expect(harness.saveCurrentReview()).rejects.toThrow('Temporary outage')

    expect(harness.getElement('review-sync-status').textContent).toBe('Retrying sync…')
    expect(harness.getReviewState()).toMatchObject({
      dirty: true,
      saveState: 'error',
    })

    await harness.saveCurrentReview()

    expect(saveAttempts).toBe(2)
    expect(harness.getElement('review-sync-status').textContent).toBe('Saved just now')
    expect(harness.getReviewState()).toMatchObject({
      dirty: false,
      saveState: 'saved',
    })
  })

  it('renders a focusable marker for ambiguous inline comments with no surviving text span', () => {
    const harness = loadTeacherAppHarness()
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
    }
    const selectedSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Claim here. Evidence matters. Claim here.',
      schedule_open: true,
      focused: true,
      last_activity_at: new Date().toISOString(),
      grading: {
        inline_annotations: [
          {
            id: 'annotation-1',
            start: 15,
            end: 15,
            original_start: 15,
            original_end: 25,
            quote: 'Claim here',
            note: 'This is now ambiguous.',
            context_before: '',
            context_after: '',
          },
        ],
      },
    }
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: selectedSession.id,
      reviewWorkspaceOpen: true,
      selectedReviewSessionSnapshot: selectedSession,
    })

    harness.renderReviewWorkspace(assignment)

    expect(harness.getElement('review-draft-surface').innerHTML).toContain('data-annotation-id="annotation-1"')
    expect(harness.getElement('review-annotation-list').innerHTML).toContain('Multiple matching passages need review')
  })

  it('opens review sessions by subscribing immediately and fetching fresh live data without waiting for a full dashboard refresh', async () => {
    const harness = loadTeacherAppHarness()
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
    }
    const selectedSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: new Date().toISOString(),
      grading: { inline_annotations: [] },
    }
    let assignmentRefreshes = 0
    let replayRefreshes = 0
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [selectedSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: null,
      reviewWorkspaceOpen: false,
    })
    harness.setRefreshAssignmentViewData(async () => {
      assignmentRefreshes += 1
    })
    harness.setRefreshSelectedReviewReplayData(async () => {
      replayRefreshes += 1
    })
    harness.stubRenderStudentCards()

    await harness.selectReviewSession(selectedSession.id)

    expect(harness.getReviewSelection().selectedReviewSessionId).toBe(selectedSession.id)
    expect(harness.getReviewSelection().reviewWorkspaceOpen).toBe(true)
    expect(assignmentRefreshes).toBe(1)
    expect(replayRefreshes).toBe(1)
  })

  it('opens review sessions with a direct fresh live-session fetch before broader refreshes settle', async () => {
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
    }
    const staleSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Stale draft',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
      grading: { inline_annotations: [] },
    }
    const freshSession = {
      ...staleSession,
      current_text: 'Fresh draft from direct fetch',
      current_url: 'https://updated.example/source',
      url_history: [{ url: 'https://updated.example/source', allowed: true }],
      last_activity_at: '2026-04-29T20:00:10.000Z',
    }
    const harness = loadTeacherAppHarness({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/edu/live-sessions/live-selected')) {
          return createJsonResponse(freshSession)
        }
        return createJsonResponse({})
      },
    })
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [staleSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: null,
      reviewWorkspaceOpen: false,
      currentView: 'assignment',
    })
    harness.setRefreshAssignmentViewData(async () => {})
    harness.setRefreshSelectedReviewReplayData(async () => {})

    await harness.selectReviewSession(staleSession.id)

    expect(harness.getReviewSelection().selectedReviewSessionSnapshot).toMatchObject({
      id: staleSession.id,
      current_text: 'Fresh draft from direct fetch',
    })
    expect(
      harness.getDashboardState().live_sessions.find((session) => session.id === staleSession.id),
    ).toMatchObject({
      current_text: 'Fresh draft from direct fetch',
      current_url: 'https://updated.example/source',
    })
  })

  it('keeps the fresher selected review session when slower summaries return older text afterward', async () => {
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
    }
    const staleSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Older summary text',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:00.000Z',
      updated_at: '2026-04-29T20:00:00.000Z',
      grading: { inline_annotations: [] },
    }
    const freshSession = {
      ...staleSession,
      current_text: 'Fresh direct text',
      last_activity_at: '2026-04-29T20:00:10.000Z',
      updated_at: '2026-04-29T20:00:10.000Z',
    }
    const harness = loadTeacherAppHarness({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/edu/live-sessions/live-selected')) {
          return createJsonResponse(freshSession)
        }
        if (url.endsWith('/api/edu/assignments/assignment-1')) {
          return createJsonResponse(assignment)
        }
        if (url.endsWith('/api/edu/assignments/assignment-1/live-summaries')) {
          return createJsonResponse({
            assignment_id: assignment.id,
            live_sessions: [staleSession],
            updated_at: '2026-04-29T20:00:01.000Z',
          })
        }
        if (url.endsWith('/api/edu/assignments/assignment-1/audit')) {
          return createJsonResponse([])
        }
        return createJsonResponse({})
      },
    })
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [staleSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: staleSession.id,
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
      selectedReviewSessionSnapshot: staleSession,
    })
    harness.stubRenderStudentCards()

    await harness.refreshSelectedReviewSessionData()
    await harness.refreshAssignmentViewData()

    expect(
      harness.getDashboardState().live_sessions.find((session) => session.id === staleSession.id),
    ).toMatchObject({
      current_text: 'Fresh direct text',
      updated_at: '2026-04-29T20:00:10.000Z',
    })
  })
})
