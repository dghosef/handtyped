import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildAttributedDocument, latestTextFromHistory } from './public/replay-view.js'

function createStubElement() {
  const listeners = new Map()
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
    addEventListener(type, listener) {
      const current = listeners.get(type) || []
      current.push(listener)
      listeners.set(type, current)
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) {
        listener(event)
      }
      return true
    },
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

function localDateInputValue(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localNativeTimeValue(ms) {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function teacherAppSource() {
  return fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'app.js'), 'utf8')
}

function teacherStylesSource() {
  return fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'styles.css'), 'utf8')
}

it('wires immediate pressed feedback for all teacher button-like controls', () => {
  const source = teacherAppSource()
  const styles = teacherStylesSource()

  expect(source).toMatch(/function initButtonPressFeedback\(\)/)
  expect(source).toMatch(/'button',\s+'a\.button',\s+'\[role="button"\]',\s+'.selection-card',\s+'.student-card'/m)
  expect(styles).toMatch(/\.selection-card:active,\s*\.selection-card\.is-pressed/m)
  expect(styles).toMatch(/\.student-card:active,\s*\.student-card\.is-pressed/m)
})

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
      deleteReviewAnnotation,
      saveCurrentReview,
      publishCurrentReviewFeedback,
      wireReviewWorkspace,
      flushReviewSave,
      selectReviewSession,
      renderReviewWorkspace,
      buildReviewPayload,
      refreshAssignmentViewData,
      refreshSelectedReviewSessionData,
      refreshSelectedReviewReplayData,
      parseReviewTimeInput,
      reviewTimeValue,
      replayTeacherDateInputValue,
      reviewTimestampMatchesHighlight,
      reviewHighlightIndexSet,
      handtypedMarkdownDisplayText,
      buildReviewReplayCacheEntry,
      documentHistoryForReviewAttribution,
      mergeReviewReplayWithLiveSession,
      annotateReplayHistoryWithEventTimes,
      attributedDocumentHasReliableInsertionTiming,
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
  const sessionPresenceTimestampStub = (session) => {
    const updatedAt = Date.parse(String(session?.updated_at || ''))
    const lastActivityAt = Date.parse(String(session?.last_activity_at || ''))
    return Math.max(
      Number.isFinite(updatedAt) ? updatedAt : 0,
      Number.isFinite(lastActivityAt) ? lastActivityAt : 0,
    ) || null
  }

  return factory(
    () => ({ totalEdits: 0, activeStudents: 0, buckets: [0] }),
    () => true,
    () => '',
    () => [],
    () => false,
    () => ({ active: true, needsAttention: false, score: 0 }),
    (hour = 0, minute = 0) => {
      const normalizedHour = Math.max(0, Math.min(23, Number(hour) || 0))
      const normalizedMinute = Math.max(0, Math.min(59, Number(minute) || 0))
      const meridiem = normalizedHour >= 12 ? 'PM' : 'AM'
      const displayHour = normalizedHour % 12 || 12
      return `${displayHour}:${String(normalizedMinute).padStart(2, '0')} ${meridiem}`
    },
    () => '',
    (session, now = Date.now()) => {
      if (!session?.schedule_open) {
        return false
      }
      const parsed = sessionPresenceTimestampStub(session)
      return Number.isFinite(parsed) && now - parsed <= 15000
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
    sessionPresenceTimestampStub,
    () => 'Focused',
    (sessions, _classroomName, assignmentId) => (sessions || []).filter((session) => session.assignment_id === assignmentId),
    (sessions) => sessions || [],
    () => 'just now',
    () => new Date(),
    () => new Date().toISOString(),
    buildAttributedDocument,
    latestTextFromHistory,
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
  it('wires immediate pressed feedback for teacher buttons', () => {
    const source = teacherAppSource()
    const styles = teacherStylesSource()

    expect(source).toMatch(/function initButtonPressFeedback\(\)/)
    expect(source).toMatch(/initButtonPressFeedback\(\)/)
    expect(source).toMatch(/document\.addEventListener\('pointerdown'/)
    expect(styles).toMatch(/\.button:active,\s*\.button\.is-pressed,/)
  })

  it('accepts AM/PM replay highlight times without treating evening as morning', () => {
    const harness = loadTeacherAppHarness()
    const highlightedAt = Date.parse('2026-05-02T18:25:00Z')
    const beforeHighlightedAt = highlightedAt - 60_000
    harness.setReviewState({
      highlightMode: 'custom',
      highlightDate: localDateInputValue(highlightedAt),
      highlightDates: '',
      highlightStartTime: localNativeTimeValue(highlightedAt),
      highlightEndTime: '',
      highlightWeekdays: [],
    })

    expect(harness.parseReviewTimeInput('6:25 PM')).toBe(18 * 60 + 25)
    expect(harness.parseReviewTimeInput('6:25pm')).toBe(18 * 60 + 25)
    expect(harness.parseReviewTimeInput('6:25p')).toBe(18 * 60 + 25)
    expect(harness.parseReviewTimeInput('18:25')).toBeNull()
    expect(harness.parseReviewTimeInput('6:25')).toBeNull()
    expect(harness.parseReviewTimeInput('12:00 AM')).toBe(0)
    expect(harness.parseReviewTimeInput('12 PM')).toBe(12 * 60)
    expect(harness.reviewTimeValue(18, 25)).toBe('6:25 PM')
    expect(harness.reviewTimeValue(0, 5)).toBe('12:05 AM')
    expect(harness.reviewTimestampMatchesHighlight(beforeHighlightedAt, 0)).toBe(false)
    expect(harness.reviewTimestampMatchesHighlight(highlightedAt, 0)).toBe(true)
    harness.setReviewState({
      highlightMode: 'custom',
      highlightDate: localDateInputValue(highlightedAt),
      highlightDates: '',
      highlightStartTime: localNativeTimeValue(highlightedAt),
      highlightEndTime: '',
      highlightWeekdays: [],
    })
    expect(harness.reviewTimestampMatchesHighlight(highlightedAt, 0)).toBe(true)
  })

  it('does not default replay highlight date to the Unix epoch when timing is missing', () => {
    const harness = loadTeacherAppHarness()

    expect(harness.replayTeacherDateInputValue(null)).toBe('')
    expect(harness.replayTeacherDateInputValue(undefined)).toBe('')
    expect(harness.replayTeacherDateInputValue(0)).toBe('')
  })

  it('uses per-entry replay times instead of batch upload times for highlight ranges', () => {
    const harness = loadTeacherAppHarness()
    const replayOrigin = Date.parse('2026-05-02T18:00:00.000Z')
    const uploadTime = '2026-05-02T18:30:00.000Z'
    const replay = {
      current_text: 'abc',
      replay_origin_wall_ms: replayOrigin,
      recorded_timezone_offset_minutes: 0,
      document_history: [
        { t: 60_000, pos: 0, del: '', ins: 'a' },
        { t: 2_100_000, pos: 1, del: '', ins: 'b' },
        { t: 2_200_000, pos: 2, del: '', ins: 'c' },
      ],
      events: [
        {
          seq: 1,
          updated_at: uploadTime,
          document_history_tail: [
            { t: 60_000, pos: 0, del: '', ins: 'a' },
            { t: 2_100_000, pos: 1, del: '', ins: 'b' },
            { t: 2_200_000, pos: 2, del: '', ins: 'c' },
          ],
        },
      ],
    }

    const annotated = harness.annotateReplayHistoryWithEventTimes(replay)
    expect(annotated.every((entry) => entry.absolute_wall_ms == null)).toBe(true)

    harness.setReviewState({
      highlightMode: 'custom',
      highlightDate: localDateInputValue(Date.parse(uploadTime)),
      highlightDates: '',
      highlightStartTime: localNativeTimeValue(Date.parse(uploadTime)),
      highlightEndTime: localNativeTimeValue(replayOrigin + 2_200_000),
      highlightWeekdays: [],
    })

    expect(harness.reviewTimestampMatchesHighlight(replayOrigin + 60_000, 0)).toBe(false)
    expect(harness.reviewTimestampMatchesHighlight(replayOrigin + 2_100_000, 0)).toBe(true)
    expect(harness.reviewTimestampMatchesHighlight(Date.parse(uploadTime), 0)).toBe(true)
  })

  it('spreads live replay batch timestamps from the event activity time instead of stamping every edit with upload time', () => {
    const harness = loadTeacherAppHarness()
    const beforeNine = new Date(2026, 4, 2, 20, 30).getTime()
    const afterNine = new Date(2026, 4, 2, 21, 5).getTime()
    const history = [
      { t: 0, pos: 0, del: '', ins: 'old' },
      { t: afterNine - beforeNine, pos: 3, del: '', ins: ' new' },
    ]
    const annotated = harness.annotateReplayHistoryWithEventTimes({
      document_history: history,
      events: [
        {
          seq: 1,
          updated_at: new Date(afterNine + 60_000).toISOString(),
          last_activity_at: new Date(afterNine).toISOString(),
          document_history_tail: history,
        },
      ],
    })

    expect(annotated.map((entry) => entry.absolute_wall_ms)).toEqual([beforeNine, afterNine])
  })

  it('keeps absolute student edit timestamps instead of replacing them with inferred fallback times', () => {
    const harness = loadTeacherAppHarness()
    const beforeNine = new Date(2026, 4, 2, 20, 30).getTime()
    const afterNine = new Date(2026, 4, 2, 21, 5).getTime()
    const history = [
      { t: 100, pos: 0, del: '', ins: 'old', absolute_wall_ms: beforeNine },
      { t: 200, pos: 3, del: '', ins: ' new', absolute_wall_ms: afterNine },
    ]
    const annotated = harness.annotateReplayHistoryWithEventTimes({
      updated_at: new Date(afterNine + 60_000).toISOString(),
      last_activity_at: new Date(afterNine + 60_000).toISOString(),
      document_history: history,
      events: [],
    })

    expect(annotated.map((entry) => entry.absolute_wall_ms)).toEqual([beforeNine, afterNine])
  })

  it('uses live fallback activity time instead of replay created_at when no replay events are present', () => {
    const harness = loadTeacherAppHarness()
    const createdAfterNine = new Date(2026, 4, 2, 21, 15).getTime()
    const beforeNine = new Date(2026, 4, 2, 20, 30).getTime()
    const afterNine = new Date(2026, 4, 2, 21, 5).getTime()
    const beforeText = 'Written before nine.'
    const afterText = ' Written after nine.'
    const replay = {
      created_at: new Date(createdAfterNine).toISOString(),
      updated_at: new Date(afterNine).toISOString(),
      last_activity_at: new Date(afterNine).toISOString(),
      current_text: `${beforeText}${afterText}`,
      document_history: [
        { t: 0, pos: 0, del: '', ins: beforeText },
        { t: afterNine - beforeNine, pos: beforeText.length, del: '', ins: afterText },
      ],
      events: [],
    }
    const replayData = harness.buildReviewReplayCacheEntry(replay)

    harness.setReviewState({
      highlightMode: 'custom',
      highlightDate: localDateInputValue(afterNine),
      highlightDates: '',
      highlightStartTime: '9:00 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
      replayData,
    })

    const indexes = harness.reviewHighlightIndexSet(
      harness.handtypedMarkdownDisplayText(replay.current_text),
      [{ custom: true }],
      replay.current_text,
    )

    expect(replayData.attributedDocument.chars.slice(0, beforeText.length).every((entry) => entry.insertedAtMs < afterNine)).toBe(true)
    expect(indexes.size).toBe(afterText.length)
    expect([...Array(beforeText.length).keys()].some((index) => indexes.has(index))).toBe(false)
    expect([...Array(afterText.length).keys()].every((offset) => indexes.has(beforeText.length + offset))).toBe(true)
  })

  it('uses live fallback activity time even when a live draft carries a misleading replay origin', () => {
    const harness = loadTeacherAppHarness()
    const badOriginAfterNine = new Date(2026, 4, 2, 21, 15).getTime()
    const beforeNine = new Date(2026, 4, 2, 20, 30).getTime()
    const afterNine = new Date(2026, 4, 2, 21, 5).getTime()
    const beforeText = 'Written before nine.'
    const afterText = ' Written after nine.'
    const replay = {
      replay_origin_wall_ms: badOriginAfterNine,
      created_at: new Date(badOriginAfterNine).toISOString(),
      updated_at: new Date(afterNine).toISOString(),
      last_activity_at: new Date(afterNine).toISOString(),
      current_text: `${beforeText}${afterText}`,
      document_history: [
        { t: 0, pos: 0, del: '', ins: beforeText },
        { t: afterNine - beforeNine, pos: beforeText.length, del: '', ins: afterText },
      ],
      events: [],
    }
    const replayData = harness.buildReviewReplayCacheEntry(replay)

    harness.setReviewState({
      highlightMode: 'custom',
      highlightDate: localDateInputValue(afterNine),
      highlightDates: '',
      highlightStartTime: '9:00 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
      replayData,
    })

    const indexes = harness.reviewHighlightIndexSet(
      harness.handtypedMarkdownDisplayText(replay.current_text),
      [{ custom: true }],
      replay.current_text,
    )

    expect(replayData.attributedDocument.chars.slice(0, beforeText.length).every((entry) => entry.insertedAtMs < afterNine)).toBe(true)
    expect(indexes.size).toBe(afterText.length)
    expect([...Array(beforeText.length).keys()].some((index) => indexes.has(index))).toBe(false)
    expect([...Array(afterText.length).keys()].every((offset) => indexes.has(beforeText.length + offset))).toBe(true)
  })

  it('highlights only surviving characters inserted inside the selected time range from replay history', () => {
    const harness = loadTeacherAppHarness()
    const beforeNine = new Date(2026, 4, 2, 20, 55).getTime()
    const afterNine = new Date(2026, 4, 2, 21, 5).getTime()
    const beforeText = 'Written before nine.'
    const afterText = ' Written after nine.'
    const displayText = `${beforeText}${afterText}`
    const replay = {
      current_text: displayText,
      document_history: [
        { t: 1000, pos: 0, del: '', ins: beforeText },
        { t: 2000, pos: beforeText.length, del: '', ins: afterText },
      ],
      events: [
        {
          seq: 1,
          last_activity_at: new Date(beforeNine).toISOString(),
          document_history_tail: [{ t: 1000, pos: 0, del: '', ins: beforeText }],
        },
        {
          seq: 2,
          last_activity_at: new Date(afterNine).toISOString(),
          document_history_tail: [{ t: 2000, pos: beforeText.length, del: '', ins: afterText }],
        },
      ],
    }
    const replayData = harness.buildReviewReplayCacheEntry(replay)

    harness.setReviewState({
      highlightMode: 'custom',
      highlightDate: localDateInputValue(afterNine),
      highlightDates: '',
      highlightStartTime: '9:00 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
      replayData,
    })

    const indexes = harness.reviewHighlightIndexSet(
      harness.handtypedMarkdownDisplayText(displayText),
      [{ custom: true }],
      displayText,
    )

    expect(indexes.size).toBe(afterText.length)
    expect([...Array(beforeText.length).keys()].some((index) => indexes.has(index))).toBe(false)
    expect([...Array(afterText.length).keys()].every((offset) => indexes.has(beforeText.length + offset))).toBe(true)
  })

  it('uses fresher live-session history when replay head lags behind the displayed draft', () => {
    const harness = loadTeacherAppHarness()
    const beforeFilter = new Date(2026, 4, 3, 19, 29, 37).getTime()
    const afterFilter = new Date(2026, 4, 3, 19, 30, 13).getTime()
    const baseText = 'Hello This is my essay'
    const displayText = `${baseText} hihiH`
    const replay = {
      current_text: baseText,
      document_history: [
        { t: 19926, pos: 0, del: '', ins: 'Hello', absolute_wall_ms: beforeFilter - 90_000 },
        { t: 25340, pos: 5, del: '', ins: ' This is my essay', absolute_wall_ms: beforeFilter - 60_000 },
      ],
    }
    const liveSession = {
      current_text: displayText,
      last_activity_at: new Date(afterFilter).toISOString(),
      document_history: [
        ...replay.document_history,
        { t: 113513, pos: baseText.length, del: '', ins: ' hihi', absolute_wall_ms: beforeFilter },
        { t: 149308, pos: baseText.length + 5, del: '', ins: 'H', absolute_wall_ms: afterFilter },
      ],
    }
    const replayData = harness.buildReviewReplayCacheEntry(
      harness.mergeReviewReplayWithLiveSession(replay, liveSession),
    )

    harness.setReviewState({
      highlightMode: 'custom',
      highlightDate: localDateInputValue(afterFilter),
      highlightDates: '',
      highlightStartTime: '7:30 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
      replayData,
    })

    const indexes = harness.reviewHighlightIndexSet(
      harness.handtypedMarkdownDisplayText(displayText),
      [{ custom: true }],
      displayText,
    )

    expect(replayData.attributedDocument.text).toBe(displayText)
    expect(indexes.size).toBe(1)
    expect(indexes.has(displayText.length - 1)).toBe(true)
  })

  it('treats one-timestamp draft attribution as unreliable for filtered highlights', () => {
    const harness = loadTeacherAppHarness()

    expect(
      harness.attributedDocumentHasReliableInsertionTiming({
        text: 'abc',
        chars: [
          { char: 'a', insertedAtMs: 1000 },
          { char: 'b', insertedAtMs: 1000 },
          { char: 'c', insertedAtMs: 1000 },
        ],
      }),
    ).toBe(false)

    expect(
      harness.attributedDocumentHasReliableInsertionTiming({
        text: 'abc',
        chars: [
          { char: 'a', insertedAtMs: 1000 },
          { char: 'b', insertedAtMs: 1100 },
          { char: 'c', insertedAtMs: 1100 },
        ],
      }),
    ).toBe(true)
  })

  it('does not show the precise timing unavailable blocker for coarse highlight timing', () => {
    const harness = loadTeacherAppHarness()
    const highlightedAt = new Date(2026, 4, 2, 21, 5).getTime()
    const replayData = {
      attributedDocument: {
        text: 'abc',
        chars: [
          { char: 'a', insertedAtMs: highlightedAt },
          { char: 'b', insertedAtMs: highlightedAt },
          { char: 'c', insertedAtMs: highlightedAt },
        ],
      },
    }
    harness.setReviewState({
      highlightMode: 'custom',
      highlightDate: localDateInputValue(highlightedAt),
      highlightDates: '',
      highlightStartTime: '9:00 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
      replayData,
    })

    expect(harness.reviewHighlightIndexSet('abc', [{ custom: true }], 'abc').size).toBe(0)
  })

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

  it('keeps live draft text updating while time-based highlighting is active', () => {
    const harness = loadTeacherAppHarness()
    const replayOrigin = Date.parse('2026-04-29T20:00:00.000Z')
    const selectedSession = {
      id: 'live-selected',
      assignment_id: 'assignment-1',
      student_name: 'Ada Lovelace',
      current_text: 'Draft one',
      document_history: [
        { t: 0, pos: 0, del: '', ins: 'Draft ' },
        { t: 1000, pos: 6, del: '', ins: 'one' },
      ],
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
      highlightMode: 'custom',
      highlightDate: localDateInputValue(replayOrigin),
      highlightDates: '',
      highlightStartTime: '8:00 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
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

    harness.handleRealtimeReplay({
      id: 'live-selected',
      current_text: 'Draft one',
      created_at: '2026-04-29T20:00:00.000Z',
      last_activity_at: '2026-04-29T20:00:00.000Z',
      updated_at: '2026-04-29T20:00:00.000Z',
      document_history: [
        { t: 0, pos: 0, del: '', ins: 'Draft ' },
        { t: 1000, pos: 6, del: '', ins: 'one' },
      ],
      events: [],
      last_seq: 1,
    })

    harness.handleRealtimeAssignment({
      assignment: { id: 'assignment-1' },
      live_sessions: [
        {
          ...selectedSession,
          current_text: 'Draft one live',
          document_history: [
            { t: 0, pos: 0, del: '', ins: 'Draft one' },
            { t: 5000, pos: 9, del: '', ins: ' live' },
          ],
          last_activity_at: '2026-04-29T20:00:05.000Z',
        },
      ],
      assignment_audits: [],
    })

    expect(harness.getDashboardState().live_sessions.find((session) => session.id === 'live-selected').current_text).toBe('Draft one live')
    expect(harness.getElement('review-draft-meta').textContent).toContain('14 characters')
    expect(harness.getElement('review-draft-surface').innerHTML).toContain('live')
    expect(harness.getReviewState().replayData.attributedDocument.text).toBe('Draft one live')
  })

  it('keeps existing time highlights visible when live text arrives before replay history', () => {
    const harness = loadTeacherAppHarness()
    const replayOrigin = new Date(2026, 3, 29, 20, 0).getTime()
    const replayOriginIso = new Date(replayOrigin).toISOString()
    harness.setReviewState({
      sessionId: 'live-selected',
      highlightMode: 'custom',
      highlightDate: localDateInputValue(replayOrigin),
      highlightDates: '',
      highlightStartTime: '8:00 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
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
    const replayData = harness.buildReviewReplayCacheEntry({
      id: 'live-selected',
      current_text: 'Draft one',
      created_at: replayOriginIso,
      last_activity_at: replayOriginIso,
      updated_at: replayOriginIso,
      document_history: [
        { t: 0, pos: 0, del: '', ins: 'Draft ' },
        { t: 1000, pos: 6, del: '', ins: 'one' },
      ],
      events: [],
      last_seq: 1,
    })
    harness.setReviewState({
      ...harness.getReviewState(),
      replayData,
      replayLoadState: 'ready',
    })

    const indexes = harness.reviewHighlightIndexSet('Draft one live', [{ custom: true }], 'Draft one live')
    expect(indexes.size).toBeGreaterThan(0)
    expect(indexes.has(6)).toBe(true)
    expect(indexes.has(8)).toBe(true)
    expect(indexes.has(9)).toBe(false)
  })

  it('ignores redundant full-document checkpoints when attributing time highlights', () => {
    const harness = loadTeacherAppHarness()
    const afterSevenThirty = new Date(2026, 4, 3, 19, 37).getTime()
    const afterEight = new Date(2026, 4, 3, 20, 20).getTime()
    const replay = {
      id: 'live-selected',
      current_text: 'Hello world',
      document_history: [
        { t: 1000, absolute_wall_ms: afterSevenThirty, pos: 0, del: '', ins: 'Hello' },
        { t: 2000, absolute_wall_ms: afterSevenThirty + 1000, pos: 5, del: '', ins: ' world' },
        { t: 180000, absolute_wall_ms: afterEight, pos: 0, del: '', ins: 'Hello world' },
      ],
    }
    const attributionHistory = harness.documentHistoryForReviewAttribution(replay)
    expect(attributionHistory).toHaveLength(2)
    expect(attributionHistory.at(-1).ins).toBe(' world')

    harness.setReviewState({
      sessionId: 'live-selected',
      highlightMode: 'custom',
      highlightDate: localDateInputValue(afterSevenThirty),
      highlightDates: '',
      highlightStartTime: '7:30 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
      replayData: harness.buildReviewReplayCacheEntry(replay),
      replayLoadState: 'ready',
      replayError: '',
    })
    const indexes = harness.reviewHighlightIndexSet('Hello world', [{ custom: true }], 'Hello world')
    expect(indexes.size).toBeGreaterThan(0)
    expect(indexes.has(0)).toBe(true)
  })

  it('does not highlight the whole draft when a live checkpoint contains the full updated text', () => {
    const harness = loadTeacherAppHarness()
    const beforeFilter = new Date(2026, 4, 3, 19, 20).getTime()
    const afterFilter = new Date(2026, 4, 3, 19, 37).getTime()
    const replay = {
      id: 'live-selected',
      current_text: 'Hello world',
      document_history: [
        { t: 1000, absolute_wall_ms: beforeFilter, pos: 0, del: '', ins: 'Hello' },
        { t: 2000, absolute_wall_ms: beforeFilter + 1000, pos: 5, del: '', ins: ' world' },
        { t: 180000, absolute_wall_ms: afterFilter, pos: 0, del: '', ins: 'Hello world' },
      ],
    }
    harness.setReviewState({
      sessionId: 'live-selected',
      highlightMode: 'custom',
      highlightDate: localDateInputValue(afterFilter),
      highlightDates: '',
      highlightStartTime: '7:30 PM',
      highlightEndTime: '',
      highlightWeekdays: [],
      replayData: harness.buildReviewReplayCacheEntry(replay),
      replayLoadState: 'ready',
      replayError: '',
    })

    const indexes = harness.reviewHighlightIndexSet('Hello world', [{ custom: true }], 'Hello world')
    expect(indexes.size).toBe(0)
  })

  it('ignores older full-document checkpoints even when later edits change the final text', () => {
    const harness = loadTeacherAppHarness()
    const beforeFilter = new Date(2026, 4, 3, 19, 20).getTime()
    const afterFilter = new Date(2026, 4, 3, 20, 22).getTime()
    const laterEdit = new Date(2026, 4, 3, 21, 39).getTime()
    const replay = {
      id: 'live-selected',
      current_text: 'Hello world again',
      document_history: [
        { t: 1000, absolute_wall_ms: beforeFilter, pos: 0, del: '', ins: 'Hello' },
        { t: 2000, absolute_wall_ms: beforeFilter + 1000, pos: 5, del: '', ins: ' world' },
        { t: 180000, absolute_wall_ms: afterFilter, pos: 0, del: '', ins: 'Hello world' },
        { t: 220000, absolute_wall_ms: laterEdit, pos: 11, del: '', ins: ' again' },
      ],
    }
    const attributionHistory = harness.documentHistoryForReviewAttribution(replay)
    expect(attributionHistory.map((entry) => entry.ins || entry.text)).toEqual(['Hello', ' world', ' again'])

    harness.setReviewState({
      sessionId: 'live-selected',
      highlightMode: 'custom',
      highlightDate: localDateInputValue(afterFilter),
      highlightDates: '',
      highlightStartTime: '8:00 PM',
      highlightEndTime: '9:00 PM',
      highlightWeekdays: [],
      replayData: harness.buildReviewReplayCacheEntry(replay),
      replayLoadState: 'ready',
      replayError: '',
    })

    const indexes = harness.reviewHighlightIndexSet('Hello world again', [{ custom: true }], 'Hello world again')
    expect(indexes.size).toBe(0)
  })

  it('treats full-document checkpoint repairs as snapshots instead of whole-draft inserts', () => {
    const harness = loadTeacherAppHarness()
    const beforeFilter = new Date(2026, 4, 3, 19, 20).getTime()
    const afterFilter = new Date(2026, 4, 3, 20, 22).getTime()
    const replay = {
      id: 'live-selected',
      current_text: 'Hello world!',
      document_history: [
        { t: 1000, absolute_wall_ms: beforeFilter, pos: 0, del: '', ins: 'Hello' },
        { t: 2000, absolute_wall_ms: beforeFilter + 1000, pos: 5, del: '', ins: ' world' },
        { t: 180000, absolute_wall_ms: afterFilter, pos: 0, del: '', ins: 'Hello world!' },
      ],
    }
    const attributionHistory = harness.documentHistoryForReviewAttribution(replay)
    expect(attributionHistory.at(-1)).toMatchObject({
      op: 'snapshot',
      text: 'Hello world!',
      ins: '',
      del: '',
    })

    harness.setReviewState({
      sessionId: 'live-selected',
      highlightMode: 'custom',
      highlightDate: localDateInputValue(afterFilter),
      highlightDates: '',
      highlightStartTime: '8:00 PM',
      highlightEndTime: '9:00 PM',
      highlightWeekdays: [],
      replayData: harness.buildReviewReplayCacheEntry(replay),
      replayLoadState: 'ready',
      replayError: '',
    })

    const indexes = harness.reviewHighlightIndexSet('Hello world!', [{ custom: true }], 'Hello world!')
    expect(indexes.size).toBe(1)
    expect(indexes.has(11)).toBe(true)
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
    expect(harness.getElement('review-highlight-meta').textContent).toContain('Pick dates, weekdays, or a time range')
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

  it('persists deleting the only inline comment instead of letting the server restore it', async () => {
    const savedPayloads = []
    const harness = loadTeacherAppHarness({
      fetchImpl: async (_url, options = {}) => {
        const payload = JSON.parse(String(options.body || '{}'))
        if (!String(_url).includes('/grading')) {
          return createJsonResponse({})
        }
        savedPayloads.push(payload)
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
    }
    const selectedSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Selected draft',
      schedule_open: true,
      focused: true,
      last_activity_at: new Date().toISOString(),
      grading: {
        feedback_status: 'published',
        inline_annotations: [
          {
            id: 'annotation-delete-me',
            type: 'comment',
            start: 0,
            end: 8,
            original_start: 0,
            original_end: 8,
            quote: 'Selected',
            note: 'Remove me.',
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

    await harness.deleteReviewAnnotation('annotation-delete-me')

    expect(harness.getReviewState().inlineAnnotations).toEqual([])
    expect(savedPayloads).toHaveLength(1)
    expect(savedPayloads[0]).toMatchObject({
      inline_annotations: [],
      allow_empty_feedback: true,
      publish_feedback: true,
    })
    expect(harness.getReviewState().dirty).toBe(false)
  })

  it('keeps autosaves published after feedback has already been published once', () => {
    const harness = loadTeacherAppHarness()
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [
        {
          id: 'live-selected',
          assignment_id: 'assignment-1',
          student_name: 'Ada Lovelace',
          current_text: 'Draft',
        },
      ],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
    })
    harness.setReviewState({
      sessionId: 'live-selected',
      feedbackStatus: 'published',
      rubricScores: {},
      gradeLabel: '',
      gradeScore: '',
      teacherComment: 'Updated visible feedback',
      returnedForRevision: false,
      inlineAnnotations: [],
      replayData: null,
      selection: null,
    })

    expect(harness.buildReviewPayload().publish_feedback).toBe(true)
  })

  it('confirms published feedback and clears the visible grading fields', async () => {
    let savedPayload = null
    const harness = loadTeacherAppHarness({
      fetchImpl: async (url, options = {}) => {
        if (!String(url).includes('/grading')) {
          return createJsonResponse({})
        }
        savedPayload = JSON.parse(String(options.body || '{}'))
        return createJsonResponse({
          id: 'live-selected',
          assignment_id: 'assignment-1',
          student_name: 'Ada Lovelace',
          current_text: 'Draft',
          grading: {
            ...savedPayload,
            updated_at: '2026-05-03T20:00:00.000Z',
            published_at: '2026-05-03T20:00:00.000Z',
            feedback_status: 'published',
          },
        })
      },
    })
    harness.stubRenderStudentCards()
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [
        {
          id: 'live-selected',
          assignment_id: 'assignment-1',
          student_name: 'Ada Lovelace',
          current_text: 'Draft',
        },
      ],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
    })
    harness.setReviewState({
      sessionId: 'live-selected',
      feedbackStatus: 'draft',
      rubricScores: {},
      gradeLabel: 'Revise',
      gradeScore: '82',
      teacherComment: 'Tighten the claim.',
      returnedForRevision: true,
      inlineAnnotations: [],
      replayData: null,
      selection: null,
      dirty: false,
      saveState: 'saved',
      deletedAnnotationIds: [],
    })
    harness.getElement('review-grade-label').value = 'Revise'
    harness.getElement('review-grade-score').value = '82'
    harness.getElement('review-teacher-comment').value = 'Tighten the claim.'
    harness.getElement('review-returned').checked = true

    await harness.publishCurrentReviewFeedback()

    expect(savedPayload.publish_feedback).toBe(true)
    expect(harness.getElement('review-grade-label').value).toBe('')
    expect(harness.getElement('review-grade-score').value).toBe('')
    expect(harness.getElement('review-teacher-comment').value).toBe('')
    expect(harness.getElement('review-returned').checked).toBe(false)
    expect(harness.getElement('review-publish-confirmation').hidden).toBe(false)
    expect(harness.getElement('review-publish-confirmation').textContent).toContain('Feedback published')
    expect(harness.getElement('review-publish-feedback').disabled).toBe(false)
    expect(harness.getElement('review-publish-feedback').textContent).toBe('Publish feedback')
    expect(harness.getReviewState().feedbackControlsClearedAfterPublish).toBe(true)
    expect(harness.getReviewState()).toMatchObject({
      gradeLabel: '',
      gradeScore: '',
      teacherComment: '',
      returnedForRevision: false,
      rubricScores: {},
    })

    harness.renderReviewWorkspace(harness.getDashboardState().assignments[0])

    expect(harness.getElement('review-grade-label').value).toBe('')
    expect(harness.getElement('review-grade-score').value).toBe('')
    expect(harness.getElement('review-teacher-comment').value).toBe('')
    expect(harness.getElement('review-returned').checked).toBe(false)
    expect(harness.getElement('review-publish-confirmation').hidden).toBe(false)
    expect(harness.getElement('review-publish-confirmation').textContent).toContain('Feedback published')
  })

  it('publishes feedback even when the selected review state has not been initialized yet', async () => {
    let savedPayload = null
    const harness = loadTeacherAppHarness({
      fetchImpl: async (url, options = {}) => {
        if (!String(url).includes('/grading')) {
          return createJsonResponse({})
        }
        savedPayload = JSON.parse(String(options.body || '{}'))
        return createJsonResponse({
          id: 'history-joseph-tan-live',
          assignment_id: 'history-assignment',
          student_name: 'Joseph Tan',
          current_text: 'History draft',
          grading: {
            ...savedPayload,
            updated_at: '2026-05-03T20:10:00.000Z',
            published_at: '2026-05-03T20:10:00.000Z',
            feedback_status: 'published',
          },
        })
      },
    })
    harness.stubRenderStudentCards()
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'history-assignment', classroom_id: 'class-history', title: 'History' }],
      live_sessions: [
        {
          id: 'history-joseph-tan-live',
          assignment_id: 'history-assignment',
          student_name: 'Joseph Tan',
          current_text: 'History draft',
        },
      ],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'history-assignment',
      selectedReviewSessionId: 'history-joseph-tan-live',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
    })
    harness.setReviewState(null)
    harness.wireReviewWorkspace()
    harness.getElement('review-teacher-comment').value = 'Primary source analysis looks stronger now.'
    harness.getElement('review-teacher-comment').dispatchEvent({ type: 'input' })
    await harness.publishCurrentReviewFeedback()

    expect(savedPayload).toMatchObject({
      publish_feedback: true,
      teacher_comment: 'Primary source analysis looks stronger now.',
    })
    expect(harness.getElement('review-publish-feedback').disabled).toBe(false)
    expect(harness.getElement('review-publish-feedback').textContent).toBe('Publish feedback')
    expect(harness.getElement('review-publish-confirmation').hidden).toBe(false)
    expect(harness.getElement('review-publish-confirmation').textContent).toContain('Feedback published')
    expect(harness.getReviewState().feedbackControlsClearedAfterPublish).toBe(true)
  })

  it('waits for queued review sync before publishing feedback and still confirms success', async () => {
    let resolveDraftSave
    const draftSaveReady = new Promise((resolve) => {
      resolveDraftSave = resolve
    })
    let resolvePublish
    const publishReady = new Promise((resolve) => {
      resolvePublish = resolve
    })
    const gradingRequests = []
    const harness = loadTeacherAppHarness({
      fetchImpl: async (url, options = {}) => {
        if (!String(url).includes('/grading')) {
          return createJsonResponse({})
        }
        const payload = JSON.parse(String(options.body || '{}'))
        gradingRequests.push(payload)
        if (gradingRequests.length === 1) {
          await draftSaveReady
          return createJsonResponse({
            id: 'live-selected',
            assignment_id: 'assignment-1',
            student_name: 'Ada Lovelace',
            current_text: 'Draft',
            grading: {
              ...payload,
              updated_at: '2026-05-03T20:00:00.000Z',
              feedback_status: 'draft',
            },
          })
        }
        await publishReady
        return createJsonResponse({
          id: 'live-selected',
          assignment_id: 'assignment-1',
          student_name: 'Ada Lovelace',
          current_text: 'Draft',
          grading: {
            ...payload,
            updated_at: '2026-05-03T20:01:00.000Z',
            published_at: '2026-05-03T20:01:00.000Z',
            feedback_status: 'published',
          },
        })
      },
    })
    harness.stubRenderStudentCards()
    harness.setDashboardState({
      classrooms: [],
      assignments: [{ id: 'assignment-1', classroom_id: 'class-1', title: 'Essay 1' }],
      live_sessions: [
        {
          id: 'live-selected',
          assignment_id: 'assignment-1',
          student_name: 'Ada Lovelace',
          current_text: 'Draft',
        },
      ],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedAssignmentId: 'assignment-1',
      selectedReviewSessionId: 'live-selected',
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
    })
    harness.setReviewState({
      sessionId: 'live-selected',
      feedbackStatus: 'draft',
      rubricScores: {},
      gradeLabel: '',
      gradeScore: '',
      teacherComment: 'Publish this after the draft save.',
      returnedForRevision: false,
      inlineAnnotations: [],
      replayData: null,
      selection: null,
      dirty: true,
      saveState: 'saving',
      deletedAnnotationIds: [],
    })
    harness.getElement('review-teacher-comment').value = 'Publish this after the draft save.'

    const draftSave = harness.saveCurrentReview()
    const publish = harness.publishCurrentReviewFeedback()

    expect(harness.getElement('review-publish-feedback').disabled).toBe(true)
    expect(harness.getElement('review-publish-feedback').textContent).toBe('Publishing…')
    expect(gradingRequests).toHaveLength(1)
    await harness.publishCurrentReviewFeedback()
    expect(gradingRequests).toHaveLength(1)

    resolveDraftSave()
    await draftSave

    expect(gradingRequests).toHaveLength(2)
    harness.renderReviewWorkspace(harness.getDashboardState().assignments[0])
    expect(harness.getElement('review-publish-feedback').disabled).toBe(true)
    expect(harness.getElement('review-publish-feedback').textContent).toBe('Publishing…')
    await harness.publishCurrentReviewFeedback()
    expect(gradingRequests).toHaveLength(2)

    resolvePublish()
    await publish

    expect(gradingRequests).toHaveLength(2)
    expect(gradingRequests[1].publish_feedback).toBe(true)
    expect(harness.getElement('review-teacher-comment').value).toBe('')
    expect(harness.getElement('review-publish-confirmation').hidden).toBe(false)
    expect(harness.getElement('review-publish-confirmation').textContent).toContain('Feedback published')
    expect(harness.getElement('review-publish-feedback').disabled).toBe(false)
    expect(harness.getElement('review-publish-feedback').textContent).toBe('Publish feedback')

    harness.renderReviewWorkspace(harness.getDashboardState().assignments[0])

    expect(harness.getElement('review-teacher-comment').value).toBe('')
    expect(harness.getElement('review-publish-confirmation').hidden).toBe(false)
    expect(harness.getElement('review-publish-confirmation').textContent).toContain('Feedback published')
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
    expect(harness.getElement('review-sync-status').textContent).toBe('Saved just now • published')
    expect(harness.getReviewState()).toMatchObject({
      dirty: false,
      saveState: 'saved',
      feedbackStatus: 'published',
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

  it('opens the review workspace before waiting on pending review saves or network refreshes', () => {
    const source = teacherAppSource()
    const selectReviewSessionSource = source.match(
      /async function selectReviewSession\(sessionId\) \{[\s\S]*?\n\}/,
    )?.[0] || ''

    expect(selectReviewSessionSource).toContain('const previousSave = saveReviewSnapshotBeforeSwitch()')
    expect(selectReviewSessionSource).not.toContain('await flushReviewSave()')
    expect(selectReviewSessionSource.indexOf('renderStudentCards()')).toBeGreaterThan(-1)
    expect(selectReviewSessionSource.indexOf('await Promise.all([')).toBeGreaterThan(-1)
    expect(selectReviewSessionSource.indexOf('renderStudentCards()')).toBeLessThan(
      selectReviewSessionSource.indexOf('await Promise.all(['),
    )
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

  it('does not roll the selected live draft back to a shorter realtime summary with the same freshness', () => {
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
    }
    const fullSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Claim here. Evidence matters. Conclusion lands.',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:10.000Z',
      updated_at: '2026-04-29T20:00:10.000Z',
      grading: { inline_annotations: [] },
    }
    const partialSummary = {
      ...fullSession,
      current_text: 'Claim here. Evidence',
    }
    const harness = loadTeacherAppHarness()
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [fullSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: fullSession.id,
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
      selectedReviewSessionSnapshot: fullSession,
    })
    harness.setReviewState({
      sessionId: fullSession.id,
      inlineAnnotations: [],
      selection: null,
      replayData: null,
      dirty: false,
      saveState: 'saved',
    })
    harness.stubRenderStudentCards()

    harness.handleRealtimeAssignment({
      assignment,
      live_sessions: [partialSummary],
      updated_at: '2026-04-29T20:00:10.000Z',
    })

    expect(
      harness.getDashboardState().live_sessions.find((session) => session.id === fullSession.id),
    ).toMatchObject({
      current_text: fullSession.current_text,
      updated_at: '2026-04-29T20:00:10.000Z',
    })
    expect(harness.getReviewSelection().selectedReviewSessionSnapshot).toMatchObject({
      current_text: fullSession.current_text,
    })
  })

  it('does not roll the selected live draft back to a slightly newer shorter prefix while typing', () => {
    const assignment = {
      id: 'assignment-1',
      classroom_id: 'class-1',
      title: 'Essay 1',
    }
    const fullSession = {
      id: 'live-selected',
      assignment_id: assignment.id,
      student_name: 'Ada Lovelace',
      current_text: 'Claim here. Evidence matters. Conclusion lands.',
      schedule_open: true,
      focused: true,
      last_activity_at: '2026-04-29T20:00:10.000Z',
      updated_at: '2026-04-29T20:00:10.000Z',
      grading: { inline_annotations: [] },
    }
    const partialSummary = {
      ...fullSession,
      current_text: 'Claim here. Evidence',
      last_activity_at: '2026-04-29T20:00:11.500Z',
      updated_at: '2026-04-29T20:00:11.500Z',
    }
    const harness = loadTeacherAppHarness()
    harness.setDashboardState({
      classrooms: [{ id: 'class-1', name: 'English 11' }],
      assignments: [assignment],
      live_sessions: [fullSession],
      assignment_audits: [],
      summary: {},
    })
    harness.setReviewSelection({
      selectedClassroomId: 'class-1',
      selectedAssignmentId: assignment.id,
      selectedReviewSessionId: fullSession.id,
      reviewWorkspaceOpen: true,
      currentView: 'assignment',
      selectedReviewSessionSnapshot: fullSession,
    })
    harness.setReviewState({
      sessionId: fullSession.id,
      inlineAnnotations: [],
      selection: null,
      replayData: null,
      dirty: false,
      saveState: 'saved',
    })
    harness.stubRenderStudentCards()

    harness.handleRealtimeAssignment({
      assignment,
      live_sessions: [partialSummary],
      updated_at: '2026-04-29T20:00:11.500Z',
    })

    expect(
      harness.getDashboardState().live_sessions.find((session) => session.id === fullSession.id),
    ).toMatchObject({
      current_text: fullSession.current_text,
      updated_at: '2026-04-29T20:00:11.500Z',
    })
  })

  it('renders live Handtyped markdown as WYSIWYG in the teacher draft view', () => {
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
      current_text: '# Heading\n\n[size=20]Large claim[/size] and **bold** text',
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

    const html = harness.getElement('review-draft-surface').innerHTML
    expect(html).toContain('review-draft-heading-h1')
    expect(html).toContain('font-size:20px')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('[size=20]')
    expect(html).not.toContain('# Heading')
    expect(harness.getElement('review-draft-meta').textContent).toContain('Live draft is 34 characters')
  })

  it('hides inline comments resolved by the student from the teacher review workspace', () => {
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
      current_text: 'Opening claim needs support.',
      schedule_open: true,
      focused: true,
      last_activity_at: new Date().toISOString(),
      grading: {
        inline_annotations: [
          {
            id: 'resolved-1',
            type: 'comment',
            start: 0,
            end: 7,
            quote: 'Opening',
            note: 'Already handled.',
            resolved_by_student: true,
            resolved_by: 'Ada Lovelace',
          },
          {
            id: 'open-1',
            type: 'comment',
            start: 14,
            end: 19,
            quote: 'needs',
            note: 'Still visible.',
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

    expect(harness.getElement('review-draft-surface').innerHTML).not.toContain('resolved-1')
    expect(harness.getElement('review-draft-surface').innerHTML).toContain('open-1')
    expect(harness.getElement('review-annotation-list').innerHTML).not.toContain('Already handled.')
    expect(harness.getElement('review-annotation-list').innerHTML).toContain('Still visible.')
  })
})
